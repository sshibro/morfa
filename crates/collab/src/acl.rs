//! Permissions on the socket (docs/BACKEND.md §2 "Permissions", §11). A connection's role comes from its ticket
//! and is cached in the actor. api pushes changes (`POST /internal/acl`, handled by the router), and every
//! connection is re-validated through api every `REVALIDATE` (± a quarter) as today's SSE streams are, so a removed
//! member stops receiving changes even when a push was lost.
//!
//! api's side of the re-validation (lane B6): `GET {MORFA_COLLAB_API_URL}/internal/design-files/:file/access?user=`
//! with `Authorization: Bearer <MORFA_COLLAB_INTERNAL_SECRET>` answers `{"role": "editor" | … | null}`.

use async_trait::async_trait;
use morfa_protocol::Role;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

pub const REVALIDATE: Duration = Duration::from_secs(20);

/// Where the actor asks for a user's current role in a file — api's link, which also hears of the actor's checkpoints.
#[async_trait]
pub trait AclSource: Send + Sync + 'static {
    /// The role, or None when the user lost access. Err: api is unreachable (the cached role stays).
    async fn role(&self, file: &str, user: &str) -> Result<Option<Role>, String>;

    /// A checkpoint of `file` at `version` was written (docs/BACKEND.md §4: the file card's thumbnail follows on api's
    /// side through the render service). Best effort, nothing waits for it; the default does nothing.
    async fn checkpointed(&self, _file: &str, _version: u64) {}
}

/// api over HTTP (plain HTTP on the private network).
pub struct HttpAcl {
    base: String,
    secret: String,
}

impl HttpAcl {
    pub fn new(base: impl Into<String>, secret: impl Into<String>) -> Self {
        HttpAcl {
            base: base.into().trim_end_matches('/').to_owned(),
            secret: secret.into(),
        }
    }
}

#[derive(Deserialize)]
struct AccessAnswer {
    role: Option<String>,
}

fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[async_trait]
impl AclSource for HttpAcl {
    async fn role(&self, file: &str, user: &str) -> Result<Option<Role>, String> {
        let url = format!(
            "{}/internal/design-files/{}/access?user={}",
            self.base,
            encode_component(file),
            encode_component(user)
        );
        let body = crate::http::get(&url, &self.secret, Duration::from_secs(5)).await?;
        let answer: AccessAnswer = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        Ok(answer.role.as_deref().and_then(Role::parse))
    }

    async fn checkpointed(&self, file: &str, version: u64) {
        let url = format!(
            "{}/internal/design-files/{}/checkpoint",
            self.base,
            encode_component(file)
        );
        let body = format!("{{\"version\":{version}}}");
        if let Err(error) =
            crate::http::post(&url, &self.secret, &body, Duration::from_secs(5)).await
        {
            tracing::debug!(file, version, %error, "checkpoint notice not delivered");
        }
    }
}

/// A fixed table (tests): `(file, user) → role`; unknown pairs keep their role.
#[derive(Default)]
pub struct StaticAcl {
    roles: Mutex<HashMap<(String, String), Option<Role>>>,
}

impl StaticAcl {
    pub fn set(&self, file: &str, user: &str, role: Option<Role>) {
        self.roles
            .lock()
            .insert((file.to_owned(), user.to_owned()), role);
    }
}

#[async_trait]
impl AclSource for StaticAcl {
    async fn role(&self, file: &str, user: &str) -> Result<Option<Role>, String> {
        self.roles
            .lock()
            .get(&(file.to_owned(), user.to_owned()))
            .copied()
            .ok_or_else(|| "unknown".to_owned())
    }
}
