// Polls the backend for a pending bridge session. The admin-server exposes
// `GET /api/admin/integrations/phone-voice/bridge/pending-session`, returning
// `{sessionId|null, phoneNumber|null, reason|null, receivingPerson|null}`.
//
// The bridge polls this endpoint whenever no WebSocket session is attached.
// Once a sessionId appears, `poll_once` returns it and the caller builds the
// streaming URL.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use tracing::warn;

#[derive(Debug, Clone, Deserialize)]
pub struct PendingSession {
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "phoneNumber")]
    pub phone_number: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "receivingPerson")]
    pub receiving_person: Option<String>,
}

pub struct SessionPoller {
    client: Client,
    url: String,
    token: Option<String>,
}

impl SessionPoller {
    pub fn new(base_url: &str, token: Option<String>) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .context("build reqwest client")?;
        let url = format!(
            "{}/api/admin/integrations/phone-voice/bridge/pending-session",
            base_url.trim_end_matches('/')
        );
        Ok(Self { client, url, token })
    }

    pub async fn poll_once(&self) -> Result<Option<PendingSession>> {
        let mut req = self.client.get(&self.url);
        if let Some(ref t) = self.token {
            req = req
                .header("X-Admin-Token", t)
                .bearer_auth(t);
        }
        let resp = req.send().await.context("pending-session GET failed")?;
        if !resp.status().is_success() {
            let token_preview = self.token.as_deref().map(|t| {
                let n = t.len();
                format!("len={} head={:?} tail={:?}", n, t.chars().take(3).collect::<String>(), t.chars().rev().take(3).collect::<String>())
            });
            warn!(status = %resp.status(), url = %self.url, token_preview = ?token_preview, "pending-session non-2xx");
            return Ok(None);
        }
        let payload: PendingSession =
            resp.json().await.context("decode pending-session JSON")?;
        if payload.session_id.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
            return Ok(None);
        }
        Ok(Some(payload))
    }
}
