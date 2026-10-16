//! `morfa-collab`: the co-editing service (lane B1, docs/BACKEND.md §2). One authoritative in-memory document per
//! open file in a [`actor::DocActor`]; ops applied by a [`engine::DocEngine`], fanned out on the same socket as
//! presence, with per-connection backpressure, idempotent reconnect and catch-up, and the ACL cache. The journal,
//! checkpoints and the lease are lane B2's, behind [`journal::Journal`] and [`lease::Lease`].

pub mod acl;
pub mod actor;
pub mod backpressure;
pub mod catchup;
pub mod client;
pub mod conn;
pub mod drain;
pub mod engine;
pub mod fields_op;
mod http;
pub mod internal;
pub mod journal;
pub mod lease;
pub mod memory;
pub mod metrics;
pub mod observe;
pub mod ops;
pub mod pg;
pub mod presence;
pub mod router;
pub mod session;
pub mod shard;
pub mod ws;

pub use router::{App, Config, Shared, Tickets};

/// Serves the app on a bound listener until `shutdown` resolves (tests bind `127.0.0.1:0`).
///
/// An HTTP/1.1 loop of its own rather than `axum::serve`: its auto-detecting connection hides the TCP stream
/// behind a private wrapper, and the collab socket needs the stream itself after the upgrade (crate::ws).
pub async fn serve(
    listener: tokio::net::TcpListener,
    app: App,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    use hyper_util::rt::{TokioIo, TokioTimer};
    use hyper_util::service::TowerToHyperService;
    let router = app.router();
    tokio::pin!(shutdown);
    loop {
        let tcp = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, _)) => tcp,
                Err(error) => {
                    // Out of descriptors and the like: back off instead of spinning.
                    tracing::warn!(%error, "accept failed");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = &mut shutdown => return Ok(()),
        };
        // Small frames go out at once: with Nagle on, a frame behind an unacknowledged one waited for the
        // peer's delayed ACK (~40 ms on Linux), on every ack and change.
        if let Err(error) = tcp.set_nodelay(true) {
            tracing::debug!(%error, "TCP_NODELAY not set");
        }
        if let Some(bytes) = app.shared.config.send_buffer
            && let Err(error) = socket2::SockRef::from(&tcp).set_send_buffer_size(bytes)
        {
            tracing::debug!(%error, "SO_SNDBUF not set");
        }
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let connection = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .serve_connection(TokioIo::new(tcp), service)
                .with_upgrades();
            if let Err(error) = connection.await {
                tracing::debug!(%error, "connection ended");
            }
        });
    }
}
