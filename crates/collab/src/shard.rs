//! Shards: single-threaded tokio runtimes, each on its own thread. A file is placed on one shard when its first
//! socket arrives; its actor and every one of its sockets run there, so the hops of an op or a cursor update
//! (socket → actor → the peers' sockets) never cross threads.
//!
//! Placement packs: a new file goes to the first shard with headroom (its measured CPU plus what its newest
//! sockets will add stays under [`PACK_LIMIT`]), else to the least loaded. A lightly loaded node therefore runs on
//! one or two threads, and each thread finds several sockets ready per wake: with 1 000 cursor users spread
//! over four threads, sleeping and waking those threads cost more than the work itself (TARGETS M10: 0.81
//! cores spread, 0.54 packed). A heavy node spreads over every shard.
//!
//! HTTP (the handshake, `/internal/*`, `/metrics`) stays on the main runtime; an upgraded socket moves to its
//! file's shard (`TcpStream::into_std` there, `from_std` on the shard, which registers it with that reactor).

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tokio::runtime::{Builder, Handle};

/// A shard takes new files while its estimated load stays under this (per mille of one core).
pub const PACK_LIMIT: u32 = 600;
/// The cost of a socket before a shard has measured its own (per mille of a core): an editor's (1 op/s of 20
/// layers and its cursor at 30 Hz: 1.2 ‰ to 1.4 ‰ measured).
/// Files that arrive together (a node start, a drain elsewhere) are placed on this estimate alone: at a cursor
/// user's 0.5 ‰, 1 000 editors arriving at once put 600 sockets on one shard (K1: op queue p50 4.3 ms). A shard
/// with 20 sockets or more uses its own measurement instead.
const DEFAULT_CONN_COST: f64 = 1.5;

fn default_conn_cost() -> f64 {
    static COST: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *COST.get_or_init(|| {
        std::env::var("MORFA_COLLAB_SOCKET_COST")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_CONN_COST)
    })
}
const SAMPLE: Duration = Duration::from_millis(500);

pub struct Shard {
    pub handle: Handle,
    /// CPU of the shard's thread over the last sample, per mille of a core.
    busy: AtomicU32,
    /// Sockets served now.
    conns: AtomicU32,
    /// Sockets placed since the last sample (not in `busy` yet).
    recent: AtomicU32,
}

impl Shard {
    fn conn_cost(&self) -> f64 {
        let conns = self.conns.load(Ordering::Relaxed);
        let busy = self.busy.load(Ordering::Relaxed);
        if conns >= 20 && busy > 0 {
            (busy as f64 / conns as f64).max(0.05)
        } else {
            default_conn_cost()
        }
    }

    /// The load this shard will carry once its newest sockets count, per mille.
    fn estimate(&self) -> f64 {
        self.busy.load(Ordering::Relaxed) as f64
            + self.recent.load(Ordering::Relaxed) as f64 * self.conn_cost()
    }
}

/// A socket counted on its shard while it lives.
pub struct ConnGuard {
    shard: Arc<Shard>,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.shard.conns.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Where each file runs; an entry lives while the file has sockets or an actor, and ends with its actor: the
/// sockets of an actor that stopped (a room moved off a hot shard, drained, closed) are still closing when their
/// clients come back, and the file is placed again then, not on the shard it left (each socket releases only the
/// placement it was counted on: `id`).
#[derive(Default)]
struct Placement {
    id: u64,
    shard: usize,
    sockets: u32,
    actor: bool,
}

pub struct Shards {
    shards: Vec<Arc<Shard>>,
    placed: Mutex<HashMap<String, Placement>>,
    rebalance: Mutex<Rebalance>,
    next_placement: std::sync::atomic::AtomicU64,
}

/// A shard over `HOT` while another is under `COOL` gives up its busiest room ([`Shards::rebalance_candidate`]).
pub const HOT: u32 = 900;
pub const COOL: u32 = 500;
/// At most one room moves per this long, so a move's own reconnects are measured before the next decision.
pub const REBALANCE_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Rebalance {
    /// The shard found hot at the last check (a move needs it hot twice in a row).
    hot: Option<usize>,
    moved_at: Option<Instant>,
    /// The room moved last and the shard it left: for the cooldown its next placement is on another shard. The
    /// hot shard's measurement lags (a sample every 500 ms): taken after the room left, it can read cool and take
    /// the room straight back when its clients reconnect.
    moved: Option<(String, usize)>,
}

/// The CPU time of the calling thread (`/proc/thread-self/schedstat`: nanoseconds on a CPU).
fn thread_cpu() -> Option<Duration> {
    let text = std::fs::read_to_string("/proc/thread-self/schedstat").ok()?;
    let ns: u64 = text.split_whitespace().next()?.parse().ok()?;
    Some(Duration::from_nanos(ns))
}

impl Shards {
    /// No shards: everything runs on the caller's runtime (tests, and `MORFA_COLLAB_SHARDS=0`).
    pub fn none() -> Self {
        Shards {
            shards: Vec::new(),
            placed: Mutex::default(),
            rebalance: Mutex::default(),
            next_placement: Default::default(),
        }
    }

    /// `n` shard threads, each running its runtime for the life of the process.
    pub fn start(n: usize) -> Self {
        let shards = (0..n)
            .map(|i| {
                let pace = pace();
                let runtime = Builder::new_current_thread()
                    .enable_all()
                    .on_thread_park(move || paced_park(pace))
                    .on_thread_unpark(|| WOKE.set(Some(Instant::now())))
                    .build()
                    .expect("shard runtime");
                let shard = Arc::new(Shard {
                    handle: runtime.handle().clone(),
                    busy: AtomicU32::new(0),
                    conns: AtomicU32::new(0),
                    recent: AtomicU32::new(0),
                });
                let sampled = Arc::clone(&shard);
                std::thread::Builder::new()
                    .name(format!("collab-shard-{i}"))
                    .spawn(move || runtime.block_on(sample(sampled)))
                    .expect("shard thread");
                shard
            })
            .collect();
        Shards {
            shards,
            placed: Mutex::default(),
            rebalance: Mutex::default(),
            next_placement: Default::default(),
        }
    }

    pub fn len(&self) -> usize {
        self.shards.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shards.is_empty()
    }

    /// The room to move off a shard that stays hot while another is cool: placement is decided when a file opens, so
    /// files opened while the node was quiet stay packed on one shard when their editors arrive (lane B7, K1: 200
    /// files on shard 0, 99 % busy, op queue p99 1 s, three shards idle). A shard over `HOT` at two checks in a row,
    /// holding two rooms or more, while another is under `COOL`, gives up its room with the most sockets; its
    /// clients reconnect and the reopened file is placed again (the hot shard is over the packing limit then). One
    /// move per `REBALANCE_COOLDOWN`.
    pub fn rebalance_candidate(&self) -> Option<String> {
        let busy: Vec<u32> = self
            .shards
            .iter()
            .map(|s| s.busy.load(Ordering::Relaxed))
            .collect();
        let mut state = self.rebalance.lock();
        let hot = (0..busy.len())
            .filter(|&i| busy[i] >= HOT)
            .max_by_key(|&i| busy[i]);
        let cool = busy.iter().any(|&b| b < COOL);
        let Some(hot) = hot.filter(|_| cool) else {
            state.hot = None;
            return None;
        };
        if state.hot != Some(hot) {
            state.hot = Some(hot);
            return None;
        }
        if state
            .moved_at
            .is_some_and(|at| at.elapsed() < REBALANCE_COOLDOWN)
        {
            return None;
        }
        let placed = self.placed.lock();
        let rooms: Vec<(&String, &Placement)> = placed
            .iter()
            .filter(|(_, p)| p.shard == hot && p.actor)
            .collect();
        if rooms.len() < 2 {
            return None;
        }
        let (file, _) = rooms.into_iter().max_by_key(|(_, p)| p.sockets)?;
        state.moved_at = Some(Instant::now());
        state.hot = None;
        state.moved = Some((file.clone(), hot));
        Some(file.clone())
    }

    /// Sets a shard's measured CPU as a sample would (tests of the rebalance).
    #[doc(hidden)]
    pub fn set_busy(&self, shard: usize, permille: u32) {
        self.shards[shard].busy.store(permille, Ordering::Relaxed);
    }

    /// The shard `file` is placed on, while it has sockets or an actor.
    pub fn shard_of(&self, file: &str) -> Option<usize> {
        self.placed.lock().get(file).map(|p| p.shard)
    }

    /// Each shard's measured CPU (per mille of a core, last sample) and its sockets now: `/healthz`, and the
    /// measurement `MORFA_COLLAB_SOCKET_COST` comes from (busy ÷ sockets).
    pub fn loads(&self) -> Vec<(u32, u32)> {
        self.shards
            .iter()
            .map(|s| {
                (
                    s.busy.load(Ordering::Relaxed),
                    s.conns.load(Ordering::Relaxed),
                )
            })
            .collect()
    }

    /// The shard for a new socket of `file` (placing the file when it has none) and the placement it is counted on;
    /// None when unsharded. The socket is counted until the guard drops; [`Shards::socket_closed`] with that
    /// placement then releases it.
    pub fn place(&self, file: &str) -> Option<(Arc<Shard>, ConnGuard, u64)> {
        if self.shards.is_empty() {
            return None;
        }
        let avoid = self.left_by(file);
        let mut placed = self.placed.lock();
        let placement = placed.entry(file.to_owned()).or_insert_with(|| Placement {
            id: self.next_placement.fetch_add(1, Ordering::Relaxed) + 1,
            shard: self.choose(avoid),
            ..Placement::default()
        });
        placement.sockets += 1;
        let id = placement.id;
        let shard = Arc::clone(&self.shards[placement.shard]);
        shard.conns.fetch_add(1, Ordering::Relaxed);
        shard.recent.fetch_add(1, Ordering::Relaxed);
        Some((Arc::clone(&shard), ConnGuard { shard }, id))
    }

    /// The shard `file` was moved off within the cooldown, which its next placement avoids.
    fn left_by(&self, file: &str) -> Option<usize> {
        let state = self.rebalance.lock();
        match (&state.moved, state.moved_at) {
            (Some((moved, shard)), Some(at))
                if moved == file && at.elapsed() < REBALANCE_COOLDOWN =>
            {
                Some(*shard)
            }
            _ => None,
        }
    }

    /// The first shard with headroom, else the least loaded; never `avoid` while there is another.
    fn choose(&self, avoid: Option<usize>) -> usize {
        let open = |i: &usize| self.shards.len() < 2 || Some(*i) != avoid;
        (0..self.shards.len())
            .filter(open)
            .find(|&i| {
                let s = &self.shards[i];
                s.estimate() + s.conn_cost() < PACK_LIMIT as f64
            })
            .unwrap_or_else(|| {
                (0..self.shards.len())
                    .filter(open)
                    .min_by(|&a, &b| {
                        self.shards[a]
                            .estimate()
                            .total_cmp(&self.shards[b].estimate())
                    })
                    .expect("shards")
            })
    }

    /// A socket of `file` counted on `placement` ended (a socket of a placement that already ended changes nothing).
    pub fn socket_closed(&self, file: &str, placement: u64) {
        let mut placed = self.placed.lock();
        if let Some(p) = placed.get_mut(file).filter(|p| p.id == placement) {
            p.sockets = p.sockets.saturating_sub(1);
            if p.sockets == 0 && !p.actor {
                placed.remove(file);
            }
        }
    }

    /// `file`'s actor started or stopped. The placement outlives its sockets while the actor lives, and ends with
    /// it: the sockets left are the stopped actor's, closing, and a client that comes back places the file anew.
    pub fn actor_alive(&self, file: &str, alive: bool) {
        let mut placed = self.placed.lock();
        if alive {
            if let Some(p) = placed.get_mut(file) {
                p.actor = true;
            }
        } else {
            placed.remove(file);
        }
    }
}

/// A busy shard parks at most once per this long (`MORFA_COLLAB_SHARD_PACE_US`, 0: never paced). Each wake of a
/// shard thread costs a context switch out and back (`finish_task_switch` was 15 % of the server's CPU at M10, with
/// ~2 800 wakes a second per thread and ~7 events each): a thread that woke less than this ago sleeps the rest
/// before it waits for events, and then finds every event of that time ready in one `epoll_wait`. M10 here: 0.75
/// → 0.60 cores, M11 p95 77–92 → 41–43 ms. An event waits at most this long, and only on a
/// shard above [`PACE_ABOVE`]: a quiet shard (M1's five editors) wakes at once, as before.
const PACE: Duration = Duration::from_millis(1);
/// Pacing starts above this measured load (per mille of a core) and stops below [`PACE_BELOW`].
const PACE_ABOVE: u32 = 250;
const PACE_BELOW: u32 = 150;

thread_local! {
    /// When this shard thread last woke from parking.
    static WOKE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
    /// This shard thread is busy enough to be paced (set by [`sample`], which runs on it).
    static PACED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn pace() -> Duration {
    std::env::var("MORFA_COLLAB_SHARD_PACE_US")
        .ok()
        .and_then(|value| value.parse().ok())
        .map_or(PACE, Duration::from_micros)
}

/// `on_thread_park` of a shard runtime: on a busy shard, the rest of `pace` since the last wake.
fn paced_park(pace: Duration) {
    if pace.is_zero() || !PACED.get() {
        return;
    }
    if let Some(since) = WOKE.get().map(|woke| woke.elapsed())
        && since < pace
    {
        std::thread::sleep(pace - since);
    }
}

/// Measures the shard thread's CPU, forever (it is the shard runtime's root future).
async fn sample(shard: Arc<Shard>) {
    let mut last = (Instant::now(), thread_cpu());
    loop {
        tokio::time::sleep(SAMPLE).await;
        let now = (Instant::now(), thread_cpu());
        if let (Some(before), Some(after)) = (last.1, now.1) {
            let wall = now.0.duration_since(last.0).as_secs_f64();
            let busy = (after.saturating_sub(before).as_secs_f64() / wall * 1000.0) as u32;
            shard.busy.store(busy, Ordering::Relaxed);
            PACED.set(if PACED.get() {
                busy >= PACE_BELOW
            } else {
                busy > PACE_ABOVE
            });
            shard.recent.store(0, Ordering::Relaxed);
        }
        last = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unmeasured shards assume `DEFAULT_CONN_COST` (an editor's) per socket: 399 sockets of new files fit on the
    /// first shard under `PACK_LIMIT`, the 400th goes to the next one (a burst of editors spreads).
    #[test]
    fn unmeasured_sockets_pack_at_an_editors_cost() {
        if std::env::var_os("MORFA_COLLAB_SOCKET_COST").is_some() {
            return;
        }
        let shards = Shards::start(2);
        let guards: Vec<_> = (0..399)
            .map(|i| shards.place(&format!("f{i}")).expect("sharded"))
            .collect();
        let first = &shards.shards[0];
        assert!(guards.iter().all(|(shard, _, _)| Arc::ptr_eq(shard, first)));
        assert_eq!(shards.loads()[0].1, 399);
        let (next, _guard, _) = shards.place("f399").expect("sharded");
        assert!(Arc::ptr_eq(&next, &shards.shards[1]));
        drop(guards);
        assert_eq!(shards.loads()[0].1, 0);
    }

    /// A shard hot at two checks in a row, with another cool, gives up its room with the most sockets; then none
    /// for the cooldown. A shard with one room keeps it (moving it would only move the heat).
    #[test]
    fn the_hot_shards_busiest_room_moves() {
        let shards = Shards::start(2);
        let mut guards = Vec::new();
        for (file, sockets) in [("busy", 3), ("quiet", 1)] {
            for _ in 0..sockets {
                guards.push(shards.place(file).expect("sharded"));
            }
            shards.actor_alive(file, true);
        }
        assert_eq!(shards.shard_of("busy"), Some(0));
        assert_eq!(shards.shard_of("quiet"), Some(0));
        // The shards' own samples overwrite `busy` every 500 ms: set it before each check.
        let check = || {
            shards.set_busy(0, 950);
            shards.set_busy(1, 100);
            shards.rebalance_candidate()
        };
        let mut moved = None;
        for _ in 0..20 {
            if let Some(file) = check().or_else(check) {
                moved = Some(file);
                break;
            }
        }
        assert_eq!(moved.as_deref(), Some("busy"));
        assert_eq!(check().or_else(check), None, "cooldown");
        // Not hot, or nothing cool: no move.
        *shards.rebalance.lock() = Rebalance::default();
        shards.set_busy(0, 950);
        shards.set_busy(1, 800);
        assert_eq!(shards.rebalance_candidate(), None);
        assert_eq!(shards.rebalance_candidate(), None);
        // One room on the hot shard: it stays.
        shards.actor_alive("quiet", false);
        let (_, guard, placement) = guards.pop().expect("quiet's socket");
        drop(guard);
        shards.socket_closed("quiet", placement);
        assert_eq!(shards.shard_of("quiet"), None);
        *shards.rebalance.lock() = Rebalance::default();
        let mut any = None;
        for _ in 0..4 {
            any = any.or(check());
        }
        assert_eq!(any, None);
        drop(guards);
    }

    /// The handover of a moved room (crates/collab tests/internal.rs `a_hot_shard_gives_up_its_busiest_room`, which
    /// failed under load): its clients come back while the stopped actor's sockets are still closing, and while the
    /// hot shard's last sample, taken after the room left, reads it cool. The file is placed anew, off the shard it
    /// left; the old sockets' closing does not touch the new placement.
    #[test]
    fn a_moved_room_reopens_off_the_shard_it_left() {
        let shards = Shards::start(2);
        let mut old = Vec::new();
        for (file, sockets) in [("busy", 2), ("quiet", 1)] {
            for _ in 0..sockets {
                old.push((file, shards.place(file).expect("sharded")));
            }
            shards.actor_alive(file, true);
        }
        let check = || {
            shards.set_busy(0, 950);
            shards.set_busy(1, 100);
            shards.rebalance_candidate()
        };
        assert_eq!(check().or_else(check).as_deref(), Some("busy"));
        // The actor stops (bye {moved}); its two sockets have not closed yet. The hot shard now reads cool.
        shards.actor_alive("busy", false);
        assert_eq!(
            shards.shard_of("busy"),
            None,
            "the placement ends with the actor"
        );
        shards.set_busy(0, 10);
        shards.set_busy(1, 20);
        let (_, back, placement) = shards.place("busy").expect("sharded");
        assert_eq!(
            shards.shard_of("busy"),
            Some(1),
            "not back on the shard it left"
        );
        shards.actor_alive("busy", true);
        // The old sockets close now: the new placement keeps its socket and its actor.
        for (file, (_, guard, id)) in old.drain(..2) {
            drop(guard);
            shards.socket_closed(file, id);
        }
        assert_eq!(shards.shard_of("busy"), Some(1));
        drop(back);
        shards.socket_closed("busy", placement);
        assert_eq!(shards.shard_of("busy"), Some(1), "the actor still holds it");
        shards.actor_alive("busy", false);
        assert_eq!(shards.shard_of("busy"), None);
        // Another file is placed as before (first shard with headroom), and so is the moved one after the cooldown.
        let (_, _other, _) = shards.place("other").expect("sharded");
        assert_eq!(shards.shard_of("other"), Some(0));
        shards.rebalance.lock().moved_at = Some(Instant::now() - REBALANCE_COOLDOWN);
        let (_, _again, _) = shards.place("busy").expect("sharded");
        assert_eq!(shards.shard_of("busy"), Some(0));
        drop(old);
    }
}
