//! The GPU path: recordings replayed into a `vello::Scene` and rendered by vello's compute pipeline on wgpu —
//! WebGPU in the browser, Vulkan (lavapipe in the cloud tests) or Metal (the Mac) natively. Bitmaps are textures
//! registered with vello (`register_texture`), the blur is a separable Gaussian in WGSL with downsampling for
//! large radii ([`blur`]), tiles are layers of a texture array composited by a quad pass ([`tiles`]).

pub mod backend;
pub mod blur;
pub mod tiles;

pub use backend::{Gpu, GpuBackend};
pub use tiles::{Quad, TILE, TileRenderer};

/// Runs a future to completion on this thread (native only: wgpu's native futures resolve at once).
#[cfg(not(target_arch = "wasm32"))]
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
