//! Limits as today's PDF route has them (server/design/router.ts, shared/design/pdf-export.ts PDF_EXPORT_LIMITS):
//! 50 pages, rasters of 96 MP each and 240 MP a job, ten jobs a minute and two at a time per account; plus the
//! service's own: a bounded queue (`429 design_pdf_busy` when full) and a time limit (`504 design_pdf_timeout`).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::request::Refusal;

#[derive(Clone, Debug)]
pub struct Limits {
    pub pages: usize,
    pub raster_megapixels: f64,
    pub raster_megapixels_total: f64,
    pub fonts: usize,
    pub widths: usize,
    pub text_length: usize,
    pub title_length: usize,
    pub faces: usize,
    pub pictures: usize,
    pub ids: usize,
    /// The request body: measurements (12 MiB today) plus the document and its pictures.
    pub body_bytes: usize,
    /// Jobs a minute per account.
    pub per_minute: usize,
    /// Jobs at a time per account (queued or running).
    pub per_account: usize,
    /// Jobs waiting beyond the running ones.
    pub queue: usize,
    /// The longest a job may take from its arrival.
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            pages: 50,
            raster_megapixels: 96.0,
            raster_megapixels_total: 240.0,
            fonts: 4_000,
            widths: 250_000,
            text_length: 2_000,
            title_length: 200,
            faces: 512,
            pictures: 10_000,
            ids: 100_000,
            body_bytes: 512 << 20,
            per_minute: 10,
            per_account: 2,
            queue: 16,
            timeout: Duration::from_secs(60),
        }
    }
}

/// Per-account admission: a sliding minute of starts and the jobs in flight.
#[derive(Default)]
pub struct Accounts {
    inner: Mutex<HashMap<String, Account>>,
}

#[derive(Default)]
struct Account {
    starts: VecDeque<Instant>,
    running: usize,
}

/// Held while an account's job is in flight; dropping it frees the slot.
pub struct Slot {
    accounts: Arc<Accounts>,
    account: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut map = self
            .accounts
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(a) = map.get_mut(&self.account) {
            a.running = a.running.saturating_sub(1);
            if a.running == 0 && a.starts.is_empty() {
                map.remove(&self.account);
            }
        }
    }
}

impl Accounts {
    /// Admits a job of `account` or refuses it (429: too many a minute, or two already in flight).
    pub fn admit(
        self: &Arc<Self>,
        account: &str,
        limits: &Limits,
        now: Instant,
    ) -> Result<Slot, Refusal> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // Forget accounts idle for a minute (the map stays the size of the active accounts).
        if map.len() > 4096 {
            map.retain(|_, a| {
                a.running > 0
                    || a.starts
                        .back()
                        .is_some_and(|t| now.duration_since(*t) < Duration::from_secs(60))
            });
        }
        let a = map.entry(account.to_owned()).or_default();
        while a
            .starts
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            a.starts.pop_front();
        }
        if a.running >= limits.per_account {
            return Err(Refusal::new(
                429,
                "design_pdf_busy",
                "This account's PDF is still being built. Wait for it.",
            ));
        }
        if a.starts.len() >= limits.per_minute {
            return Err(Refusal::new(
                429,
                "rate_limited",
                "Too many exports in a row. Wait a minute.",
            ));
        }
        a.starts.push_back(now);
        a.running += 1;
        Ok(Slot {
            accounts: self.clone(),
            account: account.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_at_a_time_ten_a_minute() {
        let accounts = Arc::new(Accounts::default());
        let limits = Limits::default();
        let t0 = Instant::now();
        let a = accounts.admit("a", &limits, t0).unwrap();
        let b = accounts.admit("a", &limits, t0).unwrap();
        assert_eq!(
            accounts.admit("a", &limits, t0).err().unwrap().code,
            "design_pdf_busy"
        );
        assert!(accounts.admit("b", &limits, t0).is_ok());
        drop(a);
        drop(b);
        for _ in 0..8 {
            drop(accounts.admit("a", &limits, t0).unwrap());
        }
        assert_eq!(
            accounts.admit("a", &limits, t0).err().unwrap().code,
            "rate_limited"
        );
        assert!(
            accounts
                .admit("a", &limits, t0 + Duration::from_secs(61))
                .is_ok()
        );
    }
}
