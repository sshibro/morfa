//! Socket tickets (docs/BACKEND.md §2, §11): api mints one per `GET /api/design-files/:id/session`, Ed25519-signed,
//! valid 60 s, bound to the user, the file, the role and the page origin. collab holds only the public key.
//!
//! Format: `base64url(claims JSON) "." base64url(signature over the claims bytes)`, no padding. api (TypeScript)
//! mints the same bytes with `crypto.sign(null, claims, privateKey)` on an Ed25519 key.

use crate::Role;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fmt;

/// How long a ticket is valid after it is minted.
pub const TICKET_TTL_SECONDS: u64 = 60;

/// What a ticket says about the connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    /// The design file (`design_files.id`).
    pub file: String,
    pub user: String,
    /// The display name the peers see (the default name when the account has none).
    pub name: String,
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// The page origin the ticket was minted for; the upgrade's `Origin` must equal it when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// Expiry, Unix seconds.
    pub exp: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    Malformed,
    Signature,
    Expired,
    WrongFile,
    WrongOrigin,
}

impl fmt::Display for TicketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TicketError::Malformed => "malformed ticket",
            TicketError::Signature => "bad ticket signature",
            TicketError::Expired => "expired ticket",
            TicketError::WrongFile => "ticket for another file",
            TicketError::WrongOrigin => "ticket for another origin",
        })
    }
}

impl std::error::Error for TicketError {}

/// Signs claims into a ticket (api's job in production; tests and loadgen mint with a test key).
pub fn mint(key: &SigningKey, claims: &Claims) -> String {
    let payload = serde_json::to_vec(claims).expect("claims serialize");
    let signature = key.sign(&payload);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

/// Checks a ticket's signature, expiry (`now` in Unix seconds), file and origin.
pub fn verify(
    key: &VerifyingKey,
    ticket: &str,
    file: &str,
    origin: Option<&str>,
    now: u64,
) -> Result<Claims, TicketError> {
    let (payload, signature) = ticket.split_once('.').ok_or(TicketError::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| TicketError::Malformed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TicketError::Malformed)?;
    let signature = Signature::from_slice(&signature).map_err(|_| TicketError::Malformed)?;
    key.verify(&payload, &signature)
        .map_err(|_| TicketError::Signature)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| TicketError::Malformed)?;
    if claims.exp <= now {
        return Err(TicketError::Expired);
    }
    if claims.file != file {
        return Err(TicketError::WrongFile);
    }
    if let (Some(want), Some(got)) = (claims.origin.as_deref(), origin)
        && want != got
    {
        return Err(TicketError::WrongOrigin);
    }
    Ok(claims)
}

/// A verifying key from its 32 bytes in base64url or standard base64 (`MORFA_COLLAB_TICKET_KEY`).
pub fn verifying_key_from_base64(text: &str) -> Option<VerifyingKey> {
    let text = text.trim();
    let bytes = URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(text))
        .ok()?;
    VerifyingKey::from_bytes(&bytes.try_into().ok()?).ok()
}

pub fn verifying_key_to_base64(key: &VerifyingKey) -> String {
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

pub fn signing_key_from_base64(text: &str) -> Option<SigningKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(text.trim().trim_end_matches('='))
        .ok()?;
    Some(SigningKey::from_bytes(&bytes.try_into().ok()?))
}

pub fn signing_key_to_base64(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

pub use ed25519_dalek::{SigningKey as TicketSigningKey, VerifyingKey as TicketVerifyingKey};

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> Claims {
        Claims {
            file: "f1".into(),
            user: "u1".into(),
            name: "Anna".into(),
            role: Role::Editor,
            team: None,
            origin: Some("https://morfa.example".into()),
            exp: 1_000,
        }
    }

    #[test]
    fn round_trip_and_refusals() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = key.verifying_key();
        let ticket = mint(&key, &claims());
        assert_eq!(
            verify(&public, &ticket, "f1", Some("https://morfa.example"), 999),
            Ok(claims())
        );
        assert_eq!(
            verify(&public, &ticket, "f1", None, 1_000),
            Err(TicketError::Expired)
        );
        assert_eq!(
            verify(&public, &ticket, "f2", None, 1),
            Err(TicketError::WrongFile)
        );
        assert_eq!(
            verify(&public, &ticket, "f1", Some("https://evil.example"), 1),
            Err(TicketError::WrongOrigin)
        );
        let other = SigningKey::from_bytes(&[8; 32]).verifying_key();
        assert_eq!(
            verify(&other, &ticket, "f1", None, 1),
            Err(TicketError::Signature)
        );
        assert_eq!(
            verify(&public, "nope", "f1", None, 1),
            Err(TicketError::Malformed)
        );
        let encoded = verifying_key_to_base64(&public);
        assert_eq!(verifying_key_from_base64(&encoded), Some(public));
    }
}
