// Windows service mode for bt-audio-bridge.
//
// Audio endpoints on Windows are session-scoped. The SCM runs services in
// session 0 (LocalSystem), which cannot open the console user's audio
// endpoints. This module implements the canonical pattern: a service in
// session 0 that cross-session-spawns the bridge worker into the interactive
// user's session via WTSQueryUserToken + CreateProcessAsUserW.

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, FALSE, HANDLE, WAIT_TIMEOUT,
};
use windows::Win32::Security::{
    DuplicateTokenEx, SecurityIdentification, TokenPrimary, TOKEN_ACCESS_MASK,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
};

use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

pub const SERVICE_NAME: &str = "bt-audio-bridge";
pub const SERVICE_DISPLAY_NAME: &str = "Self-Hosted Claw — BT Audio Bridge";
pub const SERVICE_DESCRIPTION: &str =
    "Bridges a paired Bluetooth HFP phone to the Self-Hosted Claw phone-voice backend.";

/// Arguments that describe a bridge invocation. `service install` captures
/// these and stores them in the binpath; `service run` receives them back
/// verbatim and passes them through to the cross-session worker.
#[derive(Clone, Debug, Default)]
pub struct BridgeArgs {
    pub admin_token: Option<String>,
    pub backend_url: Option<String>,
    pub backend_ws: Option<String>,
    pub capture_name: Option<String>,
    pub render_name: Option<String>,
    pub session_id: Option<String>,
    pub poll_secs: Option<u64>,
    pub sample_rate_hz: Option<u32>,
}

impl BridgeArgs {
    /// Render as the argv tail we hand to the worker process (no `service`
    /// prefix — the worker runs the normal auto-bridge path).
    pub fn to_worker_argv(&self) -> Vec<String> {
        let mut v = Vec::new();
        if let Some(x) = &self.admin_token {
            v.push("--admin-token".into());
            v.push(x.clone());
        }
        if let Some(x) = &self.backend_url {
            v.push("--backend-url".into());
            v.push(x.clone());
        }
        if let Some(x) = &self.backend_ws {
            v.push("--backend-ws".into());
            v.push(x.clone());
        }
        if let Some(x) = &self.capture_name {
            v.push("--capture-name".into());
            v.push(x.clone());
        }
        if let Some(x) = &self.render_name {
            v.push("--render-name".into());
            v.push(x.clone());
        }
        if let Some(x) = &self.session_id {
            v.push("--session-id".into());
            v.push(x.clone());
        }
        if let Some(x) = self.poll_secs {
            v.push("--poll-secs".into());
            v.push(x.to_string());
        }
        if let Some(x) = self.sample_rate_hz {
            v.push("--sample-rate-hz".into());
            v.push(x.to_string());
        }
        v
    }

    /// Render as the argv tail we persist into the binpath — a `service run`
    /// invocation that the SCM will launch.
    pub fn to_install_argv(&self) -> Vec<OsString> {
        let mut v: Vec<OsString> = vec!["service".into(), "run".into()];
        for a in self.to_worker_argv() {
            v.push(a.into());
        }
        v
    }
}

pub fn install(args: &BridgeArgs) -> Result<()> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .context("open service manager (need admin)")?;

    let exe_path =
        std::env::current_exe().context("resolve current exe for binpath")?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe_path,
        launch_arguments: args.to_install_argv(),
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .context("create service (already installed? try uninstall first)")?;

    let _ = service.set_description(SERVICE_DESCRIPTION);
    info!("service installed: {SERVICE_NAME}");
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager =
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .context("open service manager (need admin)")?;

    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
        )
        .context("open service (not installed?)")?;

    let status = service.query_status().context("query service status")?;
    if status.current_state != ServiceState::Stopped {
        let _ = service.stop();
        // Give SCM a moment so DeleteService doesn't race with a pending stop.
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(250));
            if let Ok(s) = service.query_status() {
                if s.current_state == ServiceState::Stopped {
                    break;
                }
            }
        }
    }

    service.delete().context("DeleteService")?;
    info!("service uninstalled: {SERVICE_NAME}");
    Ok(())
}

// ------------------- service runtime (SCM entry) -------------------

windows_service::define_windows_service!(ffi_service_main, service_main);

/// Shared signal from the SCM-control thread to the main run loop.
struct ServiceControlSignals {
    shutdown: Arc<AtomicBool>,
    wake: Arc<(Mutex<()>, std::sync::Condvar)>,
    active_session: Arc<AtomicU32>,
}

/// SCM-visible entry. `windows-service` hands us the launch args verbatim.
fn service_main(args: Vec<OsString>) {
    let _ = init_service_logging();
    if let Err(err) = run_service(args) {
        error!(error = %err, "service exited with error");
    }
}

fn run_service(args: Vec<OsString>) -> Result<()> {
    // Parse the pass-through bridge args out of argv. SCM strips the binpath
    // but keeps the trailing launch_arguments; our install put `service run
    // <flags>` there, and windows-service delivers the raw `<flags>` here.
    // Defensive: also accept a leading `service` / `run` if present.
    let bridge = parse_passthrough_args(&args);

    let shutdown = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(()), std::sync::Condvar::new()));
    let active_session = Arc::new(AtomicU32::new(u32::MAX));

    let signals = ServiceControlSignals {
        shutdown: shutdown.clone(),
        wake: wake.clone(),
        active_session: active_session.clone(),
    };

    let handler = {
        let signals_shutdown = signals.shutdown.clone();
        let signals_wake = signals.wake.clone();
        move |control: ServiceControl| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    signals_shutdown.store(true, Ordering::SeqCst);
                    let (lock, cvar) = &*signals_wake;
                    let _g = lock.lock();
                    cvar.notify_all();
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::SessionChange(_) => {
                    // Any session change — console connect/disconnect, logon,
                    // logoff — re-evaluate where the worker should run.
                    let (lock, cvar) = &*signals_wake;
                    let _g = lock.lock();
                    cvar.notify_all();
                    ServiceControlHandlerResult::NoError
                }
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        }
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, handler)
        .context("register service control handler")?;

    status_handle
        .set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP
                | ServiceControlAccept::SHUTDOWN
                | ServiceControlAccept::SESSION_CHANGE,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        })
        .context("report SERVICE_RUNNING")?;

    let loop_result = supervisor_loop(bridge, &signals);

    let _ = status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    });

    loop_result
}

/// Worker-process handle with the session id it was launched for.
struct Worker {
    process: HANDLE,
    session_id: u32,
}

fn supervisor_loop(bridge: BridgeArgs, signals: &ServiceControlSignals) -> Result<()> {
    let exe = std::env::current_exe().context("current_exe")?;
    let worker_argv = bridge.to_worker_argv();
    let mut current: Option<Worker> = None;
    let mut backoff = Duration::from_secs(3);
    const BACKOFF_MAX: Duration = Duration::from_secs(30);

    loop {
        if signals.shutdown.load(Ordering::SeqCst) {
            break;
        }

        let active = unsafe { WTSGetActiveConsoleSessionId() };

        // If there's a running worker for the wrong session, or the console
        // vanished, kill it so we can respawn cleanly for the new session.
        if let Some(w) = &current {
            if active == u32::MAX || w.session_id != active || !worker_is_alive(w.process) {
                let reason = if !worker_is_alive(w.process) {
                    "child exited"
                } else {
                    "session changed"
                };
                info!(
                    old_session = w.session_id,
                    new_session = active,
                    %reason,
                    "terminating worker"
                );
                terminate_worker(w.process);
                current = None;
            }
        }

        if current.is_none() && active != u32::MAX && !signals.shutdown.load(Ordering::SeqCst) {
            match spawn_worker(&exe, &worker_argv, active) {
                Ok(w) => {
                    info!(session_id = active, "worker spawned in user session");
                    signals.active_session.store(active, Ordering::SeqCst);
                    current = Some(w);
                    backoff = Duration::from_secs(3);
                }
                Err(err) => {
                    warn!(session_id = active, error = %err, "spawn failed, backing off");
                    wait_or_wake(signals, backoff);
                    backoff = std::cmp::min(backoff.saturating_mul(2), BACKOFF_MAX);
                    continue;
                }
            }
        }

        // Sleep up to 5s, interruptible via the shutdown/session-change cvar.
        wait_or_wake(signals, Duration::from_secs(5));
    }

    if let Some(w) = current.take() {
        info!("shutting down; terminating worker");
        terminate_worker(w.process);
    }

    Ok(())
}

fn wait_or_wake(signals: &ServiceControlSignals, dur: Duration) {
    let (lock, cvar) = &*signals.wake;
    let guard = lock.lock().unwrap();
    let _ = cvar.wait_timeout(guard, dur);
}

fn worker_is_alive(process: HANDLE) -> bool {
    let rc = unsafe { WaitForSingleObject(process, 0) };
    rc == WAIT_TIMEOUT
}

fn terminate_worker(process: HANDLE) {
    unsafe {
        let _ = TerminateProcess(process, 1);
        let _ = WaitForSingleObject(process, 2000);
        let _ = CloseHandle(process);
    }
}

fn spawn_worker(exe: &Path, argv_tail: &[String], session_id: u32) -> Result<Worker> {
    let user_token = query_user_token(session_id)?;
    let primary = duplicate_primary_token(user_token).inspect_err(|_| {
        unsafe {
            let _ = CloseHandle(user_token);
        };
    })?;
    unsafe {
        let _ = CloseHandle(user_token);
    }

    let mut env_block: *mut core::ffi::c_void = std::ptr::null_mut();
    let env_res =
        unsafe { CreateEnvironmentBlock(&mut env_block as *mut _, primary, FALSE) };
    if env_res.is_err() {
        unsafe {
            let _ = CloseHandle(primary);
        }
        bail!("CreateEnvironmentBlock failed: {:?}", env_res);
    }

    let cmdline = build_command_line(exe, argv_tail);
    let mut cmd_wide: Vec<u16> = OsStr::new(&cmdline).encode_wide().chain([0]).collect();
    let exe_wide: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    let cwd_wide: Vec<u16> = exe
        .parent()
        .map(|p| p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>())
        .unwrap_or_else(|| vec![0]);
    let desktop_wide: Vec<u16> = OsStr::new("winsta0\\default")
        .encode_wide()
        .chain([0])
        .collect();

    let mut startup = STARTUPINFOW::default();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop = PWSTR(desktop_wide.as_ptr() as *mut _);

    let mut proc_info = PROCESS_INFORMATION::default();

    let res = unsafe {
        CreateProcessAsUserW(
            primary,
            PCWSTR(exe_wide.as_ptr()),
            PWSTR(cmd_wide.as_mut_ptr()),
            None,
            None,
            FALSE,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            Some(env_block),
            PCWSTR(cwd_wide.as_ptr()),
            &startup,
            &mut proc_info,
        )
    };

    unsafe {
        let _ = DestroyEnvironmentBlock(env_block);
        let _ = CloseHandle(primary);
    }

    if let Err(e) = res {
        bail!("CreateProcessAsUserW failed: {e}");
    }

    unsafe {
        let _ = CloseHandle(proc_info.hThread);
    }

    Ok(Worker {
        process: proc_info.hProcess,
        session_id,
    })
}

fn query_user_token(session_id: u32) -> Result<HANDLE> {
    let mut token = HANDLE::default();
    let res = unsafe { WTSQueryUserToken(session_id, &mut token) };
    if res.is_err() {
        let gle = unsafe { GetLastError() };
        return Err(anyhow!(
            "WTSQueryUserToken(session={session_id}) failed: {:?}",
            gle
        ));
    }
    Ok(token)
}

fn duplicate_primary_token(src: HANDLE) -> Result<HANDLE> {
    let mut dup = HANDLE::default();
    // MAXIMUM_ALLOWED = 0x02000000.
    let access = TOKEN_ACCESS_MASK(0x0200_0000);
    let res = unsafe {
        DuplicateTokenEx(
            src,
            access,
            None,
            SecurityIdentification,
            TokenPrimary,
            &mut dup,
        )
    };
    if res.is_err() {
        bail!("DuplicateTokenEx failed: {res:?}");
    }
    Ok(dup)
}

fn build_command_line(exe: &Path, argv_tail: &[String]) -> String {
    // Windows command lines are a single string; argv[0] conventionally is
    // the exe path (quoted). Each arg is quoted if it contains whitespace.
    let mut s = String::new();
    s.push('"');
    s.push_str(&exe.to_string_lossy());
    s.push('"');
    for a in argv_tail {
        s.push(' ');
        if a.is_empty() || a.contains(' ') || a.contains('\t') || a.contains('"') {
            s.push('"');
            for ch in a.chars() {
                if ch == '"' {
                    s.push('\\');
                }
                s.push(ch);
            }
            s.push('"');
        } else {
            s.push_str(a);
        }
    }
    s
}

fn parse_passthrough_args(args: &[OsString]) -> BridgeArgs {
    // We accept flags with their values either `--foo bar` or `--foo=bar`.
    let flat: Vec<String> = args
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    let mut out = BridgeArgs::default();
    let mut i = 0;
    while i < flat.len() {
        let tok = &flat[i];
        let (key, inline_val) = if let Some((k, v)) = tok.split_once('=') {
            (k.to_string(), Some(v.to_string()))
        } else {
            (tok.clone(), None)
        };
        let take_val = |i: &mut usize| -> Option<String> {
            if let Some(v) = inline_val.clone() {
                return Some(v);
            }
            *i += 1;
            flat.get(*i).cloned()
        };
        match key.as_str() {
            "service" | "run" => {}
            "--admin-token" => out.admin_token = take_val(&mut i),
            "--backend-url" => out.backend_url = take_val(&mut i),
            "--backend-ws" => out.backend_ws = take_val(&mut i),
            "--capture-name" => out.capture_name = take_val(&mut i),
            "--render-name" => out.render_name = take_val(&mut i),
            "--session-id" => out.session_id = take_val(&mut i),
            "--poll-secs" => out.poll_secs = take_val(&mut i).and_then(|v| v.parse().ok()),
            "--sample-rate-hz" => {
                out.sample_rate_hz = take_val(&mut i).and_then(|v| v.parse().ok());
            }
            _ => {}
        }
        i += 1;
    }
    out
}

// ------------------- logging for service mode -------------------

/// Write to `%ProgramData%\bt-audio-bridge\service.log`, rotated at 5 MB with
/// up to 2 archived files retained. Falls back to stderr on setup failure.
fn init_service_logging() -> Result<()> {
    let dir = log_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    rotate_if_needed(&dir).ok();

    let file_appender = tracing_appender::rolling::never(&dir, "service.log");
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // The non-blocking guard would drop logs on fast shutdown; a direct writer
    // is simpler and the volume here is low.
    let _ = tracing_subscriber::fmt()
        .with_writer(file_appender)
        .with_env_filter(filter)
        .with_ansi(false)
        .try_init();
    Ok(())
}

fn log_dir() -> Result<PathBuf> {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
    Ok(base.join("bt-audio-bridge"))
}

fn rotate_if_needed(dir: &Path) -> std::io::Result<()> {
    let log = dir.join("service.log");
    let meta = match std::fs::metadata(&log) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.len() < 5 * 1024 * 1024 {
        return Ok(());
    }
    let l1 = dir.join("service.log.1");
    let l2 = dir.join("service.log.2");
    let _ = std::fs::remove_file(&l2);
    let _ = std::fs::rename(&l1, &l2);
    let _ = std::fs::rename(&log, &l1);
    Ok(())
}

/// SCM entry — called only when the binary is launched as a service.
pub fn dispatch() -> Result<()> {
    windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("service_dispatcher::start")?;
    Ok(())
}

