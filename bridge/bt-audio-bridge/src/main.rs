// bt-audio-bridge
//
// Phase 1: `enumerate` subcommand — lists active WASAPI endpoints.
// Phase 2/3/4: default mode — captures the remote-party HFP audio, streams
// PCM to the phone-voice backend over WebSocket, decodes TTS responses, and
// plays them to the HFP render endpoint.
//
// Windows-only. COM is initialised per-thread where needed (main for session
// orchestration; WASAPI capture and render threads have their own MTA apartments).

mod capture;
mod endpoints;
mod render;
mod service;
mod session;
mod ws;

use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tokio::sync::mpsc;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
};

#[derive(Parser, Debug)]
#[command(
    name = "bt-audio-bridge",
    version,
    about = "Windows Bluetooth HFP audio bridge for Self-Hosted Claw"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Substring (case-insensitive) matching the capture endpoint friendly name.
    #[arg(long, env = "BTBRIDGE_CAPTURE", default_value = "Hands-Free")]
    capture_name: String,

    /// Substring (case-insensitive) matching the render endpoint friendly name.
    #[arg(long, env = "BTBRIDGE_RENDER", default_value = "Hands-Free")]
    render_name: String,

    /// Backend base URL (e.g. http://localhost:3030). Used to poll for pending
    /// sessions. Ignored when `--backend-ws` is set.
    #[arg(long, env = "BTBRIDGE_BACKEND_URL", default_value = "http://localhost:3030")]
    backend_url: String,

    /// Full WebSocket stream URL. If set, used directly instead of polling.
    #[arg(long, env = "BTBRIDGE_BACKEND_WS")]
    backend_ws: Option<String>,

    /// Pre-known session id. If set with `--backend-url`, the bridge attaches
    /// immediately instead of polling for a pending session.
    #[arg(long, env = "BTBRIDGE_SESSION_ID")]
    session_id: Option<String>,

    /// Admin token for authentication. Passed as both a bearer header and a
    /// `?token=` query parameter on the WebSocket URL.
    #[arg(long, env = "BTBRIDGE_ADMIN_TOKEN")]
    admin_token: Option<String>,

    /// Polling interval while no session is attached (seconds).
    #[arg(long, default_value_t = 2, env = "BTBRIDGE_POLL_SECS")]
    poll_secs: u64,

    /// Capture-to-backend sample rate. HFP delivers 16 kHz; changing this is
    /// rarely useful.
    #[arg(long, default_value_t = 16_000, env = "BTBRIDGE_SAMPLE_RATE")]
    sample_rate_hz: u32,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print active WASAPI endpoints and exit (Phase 1 diagnostic).
    Enumerate,
    /// Windows service operations: install, uninstall, or (SCM-invoked) run.
    #[command(subcommand)]
    Service(ServiceCmd),
}

#[derive(Subcommand, Debug)]
enum ServiceCmd {
    /// Register the Windows service (runs as LocalSystem, cross-session
    /// spawns the bridge into the console user's session). Requires admin.
    Install(ServiceBridgeArgs),
    /// Stop + delete the Windows service. Requires admin.
    Uninstall,
    /// Invoked by the Service Control Manager. Not for interactive use.
    Run(ServiceBridgeArgs),
}

#[derive(clap::Args, Debug, Default)]
struct ServiceBridgeArgs {
    /// Admin token persisted into the service binpath (install) or forwarded
    /// to the cross-session worker (run).
    #[arg(long)]
    admin_token: Option<String>,
    #[arg(long)]
    backend_url: Option<String>,
    #[arg(long)]
    backend_ws: Option<String>,
    #[arg(long)]
    capture_name: Option<String>,
    #[arg(long)]
    render_name: Option<String>,
    #[arg(long)]
    session_id: Option<String>,
    #[arg(long)]
    poll_secs: Option<u64>,
    #[arg(long)]
    sample_rate_hz: Option<u32>,
}

impl From<ServiceBridgeArgs> for service::BridgeArgs {
    fn from(a: ServiceBridgeArgs) -> Self {
        Self {
            admin_token: a.admin_token,
            backend_url: a.backend_url,
            backend_ws: a.backend_ws,
            capture_name: a.capture_name,
            render_name: a.render_name,
            session_id: a.session_id,
            poll_secs: a.poll_secs,
            sample_rate_hz: a.sample_rate_hz,
        }
    }
}

fn main() -> Result<()> {
    // Parse CLI before tracing init so the service path can install its own
    // file-based subscriber. Previously we unconditionally initialised stdout
    // tracing, which silently blocked init_service_logging's try_init.
    let cli = Cli::parse();
    let is_service_run = matches!(cli.command, Some(Command::Service(ServiceCmd::Run(_))));
    if !is_service_run {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info"));
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    // Main-thread COM (apartment-threaded) for enumeration; streaming threads
    // initialise their own MTA apartments independently.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let result = match cli.command {
        Some(Command::Enumerate) => {
            endpoints::enumerate_and_print().context("enumerate endpoints")
        }
        Some(Command::Service(ServiceCmd::Install(args))) => {
            service::install(&args.into())
        }
        Some(Command::Service(ServiceCmd::Uninstall)) => service::uninstall(),
        Some(Command::Service(ServiceCmd::Run(_))) => {
            // Hand control to the SCM. The service loop parses its pass-through
            // args from the argv delivered by the service dispatcher, so we
            // deliberately ignore the `ServiceBridgeArgs` parsed by clap here —
            // clap has already consumed those tokens to satisfy the subcommand.
            service::dispatch()
        }
        None => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("build tokio runtime")?;
            runtime.block_on(run_auto_bridge(cli))
        }
    };

    unsafe {
        CoUninitialize();
    }

    if let Err(err) = &result {
        eprintln!("bt-audio-bridge: fatal error: {err:#}");
        std::process::exit(1);
    }
    Ok(())
}

async fn run_auto_bridge(cli: Cli) -> Result<()> {
    let poller = session::SessionPoller::new(&cli.backend_url, cli.admin_token.clone())?;

    loop {
        // Attach phase: figure out which session to stream.
        let (ws_url, token) = match (cli.backend_ws.as_ref(), cli.session_id.as_ref()) {
            (Some(ws_url), _) => (ws_url.clone(), cli.admin_token.clone()),
            (None, Some(sid)) => (
                build_stream_url(&cli.backend_url, sid, cli.admin_token.as_deref()),
                cli.admin_token.clone(),
            ),
            (None, None) => {
                // Poll until a session appears.
                let pending = wait_for_session(&poller, cli.poll_secs).await;
                let Some(pending) = pending else {
                    info!("shutdown requested during poll");
                    return Ok(());
                };
                let sid = pending.session_id.clone().unwrap_or_default();
                info!(
                    session_id = %sid,
                    phone = ?pending.phone_number,
                    reason = ?pending.reason,
                    person = ?pending.receiving_person,
                    "bridge attaching to pending session"
                );
                (
                    build_stream_url(&cli.backend_url, &sid, cli.admin_token.as_deref()),
                    cli.admin_token.clone(),
                )
            }
        };

        if let Err(err) = run_one_session(&cli, ws_url, token).await {
            warn!(error = %err, "session ended with error");
        }

        // If session_id was explicitly set, the user asked for a single attach
        // attempt — don't loop.
        if cli.session_id.is_some() || cli.backend_ws.is_some() {
            return Ok(());
        }

        info!("session closed; resuming polling");
    }
}

async fn wait_for_session(
    poller: &session::SessionPoller,
    poll_secs: u64,
) -> Option<session::PendingSession> {
    let mut interval = tokio::time::interval(Duration::from_secs(poll_secs.max(1)));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return None,
            _ = interval.tick() => {
                match poller.poll_once().await {
                    Ok(Some(pending)) => return Some(pending),
                    Ok(None) => {}
                    Err(err) => warn!(error = %err, "pending-session poll failed"),
                }
            }
        }
    }
}

async fn run_one_session(cli: &Cli, ws_url: String, token: Option<String>) -> Result<()> {
    // mpsc channels bridge the WASAPI OS threads to the async WebSocket task.
    // Sized to ~2 s of 20 ms frames so a brief hiccup doesn't drop audio.
    let (capture_tx, capture_rx) = mpsc::channel::<bytes::Bytes>(100);
    let (render_tx, render_rx) = mpsc::channel::<bytes::Bytes>(100);

    let capture = capture::spawn_capture(cli.capture_name.clone(), capture_tx)
        .context("spawn capture thread")?;
    let render = render::spawn_render(cli.render_name.clone(), render_rx)
        .context("spawn render thread")?;

    let cfg = ws::WsRunConfig {
        url: ws_url,
        token,
        sample_rate_hz: cli.sample_rate_hz,
    };

    let ws_result = tokio::select! {
        res = ws::run_session(cfg, capture_rx, render_tx) => res,
        _ = tokio::signal::ctrl_c() => {
            info!("ctrl-c received; tearing down session");
            Ok(())
        }
    };

    capture.stop();
    render.stop();

    ws_result
}

fn build_stream_url(base: &str, session_id: &str, token: Option<&str>) -> String {
    let http = base.trim_end_matches('/');
    // Rewrite http(s) -> ws(s) for the WebSocket upgrade.
    let ws_scheme = if let Some(rest) = http.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = http.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        http.to_string()
    };
    let encoded = urlencode(session_id);
    let mut url = format!(
        "{ws_scheme}/api/admin/integrations/phone-voice/browser/{encoded}/stream"
    );
    if let Some(t) = token {
        url.push_str("?token=");
        url.push_str(&urlencode(t));
    }
    url
}

fn urlencode(s: &str) -> String {
    // Minimal RFC 3986 unreserved-char encoder. Full url crate pulls in a lot
    // of deps for what's effectively a session id + token.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
