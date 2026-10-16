//! `morfa-model-bench`: the measurements behind the codec choice (JSON against the store's binary codec, memory per
//! node, journal entries, hostile input). Build it in release. The bincode and rkyv variants it compared postcard with
//! are in commit 122e59c (`--features bincode,rkyv` there).
//!
//! ```text
//! morfa-model-bench report <file.json> [runs=7]           JSON, conversions, codecs, memory (min and median of runs)
//! morfa-model-bench journal <file.json> [runs=7]          journal entries of typical edits, and a rebuild from snapshot + journal
//! morfa-model-bench fuzz <file.json> [iterations=100000]  damaged frames and entries: decoded, refused, or panicked
//! morfa-model-bench frames <file.json> <dir>              writes the file's frames (compact JSON and postcard) to <dir>
//! morfa-model-bench profile <file.json> postcard [n=20]    decodes the file's frame n times (for a profiler)
//! ```
//!
//! Bytes are counted by a global allocator: `live` is what the program holds (requested sizes), `chunks` the same
//! rounded as glibc's malloc does (16-byte chunks with an 8-byte header, 32 at least), closer to the resident size.

// The counting allocator implements `GlobalAlloc`, an unsafe trait. The library itself has no unsafe code.
#![allow(unsafe_code)]

use morfa_model::store::{Document, Entry, Node, Prop};
use morfa_model::{
    DesignDocument, DocumentPatch, SceneNode, codec, from_json, from_json_validated, to_json,
    validate_document,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

// ── Counting allocator ───────────────────────────────────────────────────────────────────────────

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static CHUNKS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// glibc's chunk for a request of `size` bytes on 64-bit targets.
fn chunk(size: usize) -> usize {
    ((size + 8 + 15) & !15).max(32)
}

fn counted(size: usize) {
    let live = LIVE.fetch_add(size, Relaxed) + size;
    PEAK.fetch_max(live, Relaxed);
    CHUNKS.fetch_add(chunk(size), Relaxed);
    ALLOCATED.fetch_add(size, Relaxed);
    ALLOCATIONS.fetch_add(1, Relaxed);
}

fn released(size: usize) {
    LIVE.fetch_sub(size, Relaxed);
    CHUNKS.fetch_sub(chunk(size), Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            counted(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            counted(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        released(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() {
            released(layout.size());
            counted(new_size);
        }
        new
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[derive(Clone, Copy)]
struct Mem {
    live: usize,
    chunks: usize,
    allocated: usize,
    allocations: usize,
}

impl Mem {
    fn now() -> Mem {
        PEAK.store(LIVE.load(Relaxed), Relaxed);
        Mem {
            live: LIVE.load(Relaxed),
            chunks: CHUNKS.load(Relaxed),
            allocated: ALLOCATED.load(Relaxed),
            allocations: ALLOCATIONS.load(Relaxed),
        }
    }

    /// What happened since `self`: live bytes held (may be negative), bytes and allocations made.
    fn since(self) -> (isize, isize, usize, usize) {
        let now = Mem::now();
        (
            now.live as isize - self.live as isize,
            now.chunks as isize - self.chunks as isize,
            now.allocated - self.allocated,
            now.allocations - self.allocations,
        )
    }
}

// ── Timing ───────────────────────────────────────────────────────────────────────────────────────

struct Timing {
    min: Duration,
    median: Duration,
}

impl Timing {
    fn ms(&self) -> String {
        format!(
            "{:.2} ms (median {:.2})",
            self.min.as_secs_f64() * 1e3,
            self.median.as_secs_f64() * 1e3
        )
    }

    fn us(&self) -> String {
        format!(
            "{:.1} µs (median {:.1})",
            self.min.as_secs_f64() * 1e6,
            self.median.as_secs_f64() * 1e6
        )
    }
}

/// Times `run` `runs` times; its result is dropped outside the timed part.
fn time<T>(runs: usize, mut run: impl FnMut() -> T) -> Timing {
    time_with(runs, || (), |()| run())
}

/// Times `run` on a fresh input from `setup` each time (setup and drop are not timed).
fn time_with<I, T>(
    runs: usize,
    mut setup: impl FnMut() -> I,
    mut run: impl FnMut(I) -> T,
) -> Timing {
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let input = setup();
        let start = Instant::now();
        let out = black_box(run(black_box(input)));
        times.push(start.elapsed());
        drop(out);
    }
    times.sort();
    Timing {
        min: times[0],
        median: times[times.len() / 2],
    }
}

fn per_node(bytes: isize, nodes: usize) -> String {
    format!(
        "{:.1} MB, {:.0} B/node",
        bytes as f64 / 1e6,
        bytes as f64 / nodes as f64
    )
}

// ── Codecs ───────────────────────────────────────────────────────────────────────────────────────

type Encode = fn(&Document) -> Vec<u8>;
type Decode = fn(&[u8]) -> Result<Document, codec::CodecError>;
type EncodeEntry = fn(&Entry) -> Vec<u8>;
type DecodeEntry = fn(&[u8]) -> Result<Entry, codec::CodecError>;

/// A binary codec of the store and its journal records.
struct Codec {
    name: &'static str,
    encode: Encode,
    decode: Decode,
    encode_entry: EncodeEntry,
    decode_entry: DecodeEntry,
}

/// The codecs measured: postcard only since the comparison (commit 122e59c also lists bincode and rkyv here).
fn codecs() -> Vec<Codec> {
    vec![Codec {
        name: "postcard",
        encode: codec::encode,
        decode: codec::decode,
        encode_entry: Entry::to_bytes,
        decode_entry: Entry::from_bytes,
    }]
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |at: usize, default: usize| -> usize {
        args.get(at)
            .map(|value| value.parse().expect("a number"))
            .unwrap_or(default)
    };
    match args.first().map(String::as_str) {
        Some("report") if args.len() >= 2 => report(&args[1], arg(2, 7)),
        Some("journal") if args.len() >= 2 => journal(&args[1], arg(2, 7)),
        Some("fuzz") if args.len() >= 2 => fuzz(&args[1], arg(2, 100_000), arg(3, 1) as u64),
        Some("frames") if args.len() == 3 => frames(&args[1], &args[2]),
        Some("profile") if args.len() >= 3 => profile(&args[1], &args[2], arg(3, 20)),
        _ => {
            eprintln!(
                "usage: morfa-model-bench report|journal <file.json> [runs] | fuzz <file.json> [iterations] [seed] | frames <file.json> <dir>"
            );
            return ExitCode::from(2);
        }
    }
    ExitCode::SUCCESS
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn sizes() {
    use std::mem::size_of;
    println!(
        "size_of: store Node {}, Prop {}, Props {}, Paint {}, Effect {}, List<Paint> {}, TextProps {}, Option<Arc<Node>> {}; \
         JSON model SceneNode {}, Paint {}",
        size_of::<Node>(),
        size_of::<Prop>(),
        size_of::<morfa_model::store::Props>(),
        size_of::<morfa_model::store::Paint>(),
        size_of::<morfa_model::store::Effect>(),
        size_of::<morfa_model::store::List<morfa_model::store::Paint>>(),
        size_of::<morfa_model::store::TextProps>(),
        size_of::<Option<std::sync::Arc<Node>>>(),
        size_of::<SceneNode>(),
        size_of::<morfa_model::Paint>(),
    );
}

fn report(path: &str, runs: usize) {
    let text = read(path);
    sizes();
    // ── JSON ──
    let model = from_json_validated(&text).expect("a valid document");
    let nodes = model.nodes.len();
    let compact = to_json(&model);
    println!(
        "file {path}: {nodes} nodes, JSON {} bytes (to_json writes {})",
        text.len(),
        compact.len()
    );
    println!(
        "json parse (from_json): {}",
        time(runs, || from_json(&text).unwrap()).ms()
    );
    println!(
        "json parse+validate (from_json_validated): {}",
        time(runs, || from_json_validated(&text).unwrap()).ms()
    );
    println!(
        "validate only: {}",
        time(runs, || validate_document(&model)).ms()
    );
    println!(
        "json serialize (to_json): {}",
        time(runs, || to_json(&model)).ms()
    );
    println!(
        "store from_model: {}",
        time(runs, || Document::from_model(&model)).ms()
    );
    let doc = Document::from_model(&model);
    assert_eq!(doc.to_model(), model);
    println!("store to_model: {}", time(runs, || doc.to_model()).ms());
    println!(
        "JSON text -> store (from_json_validated + from_model): {}",
        time(runs, || Document::from_model(
            &from_json_validated(&text).unwrap()
        ))
        .ms()
    );
    println!(
        "JSON text -> store, unvalidated (from_json + from_model): {}",
        time(runs, || Document::from_model(&from_json(&text).unwrap())).ms()
    );
    println!(
        "store -> JSON text (to_model + to_json): {}",
        time(runs, || to_json(&doc.to_model())).ms()
    );

    // ── Codecs ──
    for codec in codecs() {
        let bytes = (codec.encode)(&doc);
        let decoded = (codec.decode)(&bytes).expect("decodes");
        assert!(decoded == doc, "{}: round trip", codec.name);
        println!(
            "{}: {} bytes ({:.1}% of the JSON), encode {}, decode {}, decode + to_model + to_json {}",
            codec.name,
            bytes.len(),
            bytes.len() as f64 * 100.0 / text.len() as f64,
            time(runs, || (codec.encode)(&doc)).ms(),
            time(runs, || (codec.decode)(&bytes).unwrap()).ms(),
            time(runs, || to_json(
                &(codec.decode)(&bytes).unwrap().to_model()
            ))
            .ms(),
        );
    }

    // ── Memory ──
    drop(compact);
    let before = Mem::now();
    let parsed = from_json(&text).unwrap();
    let (live, chunks, ..) = before.since();
    println!(
        "memory: JSON model (DesignDocument) live {}; malloc chunks {}",
        per_node(live, nodes),
        per_node(chunks, nodes)
    );
    drop(parsed);
    let before = Mem::now();
    let built = Document::from_model(&model);
    let (live, chunks, _, allocations) = before.since();
    println!(
        "memory: store after from_model live {}; malloc chunks {}; {:.1} allocations/node",
        per_node(live, nodes),
        per_node(chunks, nodes),
        allocations as f64 / nodes as f64,
    );
    breakdown(&built, live);
    drop(built);
    for codec in codecs() {
        let bytes = (codec.encode)(&doc);
        let before = Mem::now();
        let decoded = (codec.decode)(&bytes).unwrap();
        let peak = PEAK.load(Relaxed) - before.live;
        let (live, chunks, allocated, allocations) = before.since();
        println!(
            "memory: store after {} decode live {}; malloc chunks {}; {:.1} allocations/node ({:.1} MB allocated in all, \
             peak {:.1} MB above the frame)",
            codec.name,
            per_node(live, nodes),
            per_node(chunks, nodes),
            allocations as f64 / nodes as f64,
            allocated as f64 / 1e6,
            peak as f64 / 1e6,
        );
        drop(decoded);
    }
    clones(&doc, &model, runs);
}

/// Where the store's bytes go, from its public API.
fn breakdown(doc: &Document, total: isize) {
    use std::mem::size_of;
    let nodes = doc.len();
    let interners = doc.ids().heap_bytes() + doc.atoms().heap_bytes();
    let slab = doc.ids().len() * size_of::<Option<std::sync::Arc<Node>>>();
    let arcs = nodes * (2 * size_of::<usize>() + size_of::<Node>());
    let mut children = 0;
    let mut lists = 0;
    let mut boxed = 0;
    let mut bags = 0;
    let mut text = 0;
    let mut vectors = 0;
    for node in doc.nodes() {
        children += node
            .children
            .as_ref()
            .map_or(0, |children| 16 + 4 * children.len());
        lists += node.fills.heap_bytes() + node.strokes.heap_bytes() + node.effects.heap_bytes();
        for paint in node.fills.iter().chain(node.strokes.iter()) {
            match paint {
                morfa_model::store::Paint::Solid(_) => {}
                morfa_model::store::Paint::Gradient(gradient) => {
                    boxed +=
                        size_of::<morfa_model::store::GradientPaint>() + gradient.stops.heap_bytes()
                }
                morfa_model::store::Paint::Image(_) => {
                    boxed += size_of::<morfa_model::store::ImagePaint>()
                }
            }
        }
        bags += node.props.heap_bytes();
        if let Some(props) = node.props.text() {
            text += 16
                + size_of::<morfa_model::store::TextProps>()
                + 16
                + props.characters.len()
                + props.runs.heap_bytes()
                + props
                    .list_types
                    .as_ref()
                    .map_or(0, |list| list.heap_bytes());
        }
        if let Some(paths) = node.props.vector_paths() {
            vectors += paths.heap_bytes()
                + paths
                    .iter()
                    .map(|path| path.commands.heap_bytes())
                    .sum::<usize>();
        }
    }
    let known = interners + slab + arcs + children + lists + boxed + bags + text + vectors;
    let per = |bytes: usize| bytes as f64 / nodes as f64;
    println!(
        "  breakdown per node: node Arcs {:.0} (16 + Node {}), slab {:.1}, interners {:.1} (ids {} B + atoms {} B in all), \
         children lists {:.1}, paint/effect lists {:.1} (+ boxed gradients/images {:.1}), props bags {:.1}, \
         text values {:.1}, vector paths {:.1}, rest (other bag values, tables) {:.1}",
        per(arcs),
        size_of::<Node>(),
        per(slab),
        per(interners),
        doc.ids().heap_bytes(),
        doc.atoms().heap_bytes(),
        per(children),
        per(lists),
        per(boxed),
        per(bags),
        per(text),
        per(vectors),
        (total as f64 - known as f64) / nodes as f64,
    );
    println!(
        "  interners: {} ids, {} atoms",
        doc.ids().len(),
        doc.atoms().len()
    );
}

fn clones(doc: &Document, model: &DesignDocument, runs: usize) {
    let timing = time(runs, || doc.clone());
    let before = Mem::now();
    let mut copy = doc.clone();
    let (live, _, allocated, allocations) = before.since();
    println!(
        "clone: {} ; {allocated} bytes in {allocations} allocations (live {live})",
        timing.us()
    );
    let id = copy.nodes().nth(copy.len() / 2).unwrap().id;
    let before = Mem::now();
    copy.node_mut(id).unwrap().x += 1.0;
    let (_, _, allocated, allocations) = before.since();
    println!(
        "node_mut after clone: {allocated} bytes in {allocations} allocations (Arc<Node> copied: 16 + {})",
        std::mem::size_of::<Node>()
    );
    let before = Mem::now();
    copy.node_mut(id).unwrap().y += 1.0;
    let (_, _, allocated, _) = before.since();
    println!("second node_mut of the same node: {allocated} bytes");
    drop(copy);
    // A one-node commit, on a document alone and on one sharing its interners with a kept snapshot.
    let patch = move_patch(model, &leaves(model, 1), 10.0, 0.0);
    let mut alone = codec::decode(&codec::encode(doc)).unwrap();
    let before = Mem::now();
    let start = Instant::now();
    black_box(alone.commit(&patch));
    let elapsed = start.elapsed();
    let (_, _, allocated, _) = before.since();
    println!(
        "commit (1 node) on an unshared document: {:.1} µs, {allocated} bytes allocated",
        elapsed.as_secs_f64() * 1e6
    );
    let snapshot = alone.clone();
    let before = Mem::now();
    let start = Instant::now();
    black_box(alone.commit(&patch));
    let elapsed = start.elapsed();
    let (_, _, allocated, _) = before.since();
    println!(
        "commit (1 node) while a snapshot clone is kept: {:.1} µs, {allocated} bytes allocated",
        elapsed.as_secs_f64() * 1e6
    );
    drop(snapshot);
}

// ── Journal ──────────────────────────────────────────────────────────────────────────────────────

/// The first `count` leaves (nodes without children) in file order.
fn leaves(model: &DesignDocument, count: usize) -> Vec<String> {
    model
        .nodes
        .values()
        .filter(|node| node.children.is_none() && node.parent_id.is_some())
        .take(count)
        .map(|node| node.id.clone())
        .collect()
}

fn move_patch(model: &DesignDocument, keys: &[String], dx: f64, dy: f64) -> DocumentPatch {
    let mut nodes = morfa_model::Map::default();
    for key in keys {
        let mut node = model.nodes[key].clone();
        node.x += dx;
        node.y += dy;
        nodes.insert(key.clone(), Some(node));
    }
    DocumentPatch {
        nodes: Some(nodes),
        ..DocumentPatch::default()
    }
}

/// `count` new rectangles (new ids, new names) in the first container, and the container's new children list.
fn add_patch(model: &DesignDocument, count: usize) -> DocumentPatch {
    let container = model
        .nodes
        .values()
        .find(|node| {
            node.children
                .as_ref()
                .is_some_and(|children| !children.is_empty())
                && node.parent_id.is_some()
        })
        .expect("a container");
    let template = model.nodes[&leaves(model, 1)[0]].clone();
    let mut parent = container.clone();
    let mut nodes = morfa_model::Map::default();
    for i in 0..count {
        let mut node = template.clone();
        node.id = format!("added-{i}");
        node.name = format!("New layer {i}");
        node.parent_id = Some(container.id.clone());
        node.x = i as f64 * 12.0;
        parent.children.as_mut().unwrap().push(node.id.clone());
        nodes.insert(node.id.clone(), Some(node));
    }
    nodes.insert(parent.id.clone(), Some(parent));
    DocumentPatch {
        nodes: Some(nodes),
        ..DocumentPatch::default()
    }
}

fn descendants(model: &DesignDocument, key: &str, out: &mut Vec<String>) {
    for child in model.nodes[key].children.iter().flatten() {
        out.push(child.clone());
        descendants(model, child, out);
    }
}

/// Removes the first group (or frame) with about `size` descendants, and updates its parent. Returns the patch and
/// how many nodes it removes.
fn delete_patch(model: &DesignDocument, size: usize) -> (DocumentPatch, usize) {
    let mut best: Option<(usize, Vec<String>, &SceneNode)> = None;
    for node in model.nodes.values() {
        if node.children.is_none() || node.parent_id.is_none() {
            continue;
        }
        let mut below = Vec::new();
        descendants(model, &node.id, &mut below);
        let distance = below.len().abs_diff(size);
        if best.as_ref().is_none_or(|(d, ..)| distance < *d) {
            best = Some((distance, below, node));
        }
        if distance == 0 {
            break;
        }
    }
    let (_, below, group) = best.expect("a container");
    let mut parent = model.nodes[group.parent_id.as_ref().unwrap()].clone();
    parent
        .children
        .as_mut()
        .unwrap()
        .retain(|child| *child != group.id);
    let mut nodes = morfa_model::Map::default();
    nodes.insert(group.id.clone(), None);
    for key in &below {
        nodes.insert(key.clone(), None);
    }
    nodes.insert(parent.id.clone(), Some(parent));
    (
        DocumentPatch {
            nodes: Some(nodes),
            ..DocumentPatch::default()
        },
        below.len() + 1,
    )
}

fn journal(path: &str, runs: usize) {
    let text = read(path);
    let model = from_json_validated(&text).expect("a valid document");
    let doc = Document::from_model(&model);
    let snapshot = codec::encode(&doc);
    let fresh = || codec::decode(&snapshot).unwrap();
    println!("file {path}: {} nodes", doc.len());
    let (delete, removed) = delete_patch(&model, 48);
    let scenarios: Vec<(String, DocumentPatch)> = vec![
        (
            "move 1 node".into(),
            move_patch(&model, &leaves(&model, 1), 10.0, 0.0),
        ),
        (
            "drag 20 nodes".into(),
            move_patch(&model, &leaves(&model, 20), 10.0, 5.0),
        ),
        (
            "add 50 nodes (new ids and names) + parent".into(),
            add_patch(&model, 50),
        ),
        (format!("delete a group ({removed} nodes) + parent"), delete),
    ];
    for (name, patch) in &scenarios {
        let json = serde_json::to_string(patch).unwrap().len();
        let commit = time_with(runs, fresh, |mut doc| {
            let entry = doc.commit(patch);
            (doc, entry)
        });
        let entry = fresh().commit(patch);
        println!(
            "{name}: JSON patch {json} bytes; commit (patch -> entry, applied) {}; {} new ids, {} new atoms",
            commit.us(),
            entry.new_ids.len(),
            entry.new_atoms.len()
        );
        let base = fresh();
        let mut expected = base.clone();
        expected.commit(patch);
        for codec in codecs() {
            let bytes = (codec.encode_entry)(&entry);
            let decoded = (codec.decode_entry)(&bytes).unwrap();
            assert!(decoded == entry, "{}: entry round trip", codec.name);
            let replay = time_with(runs, fresh, |mut doc| {
                doc.replay(&decoded).unwrap();
                doc
            });
            let mut replayed = fresh();
            replayed.replay(&decoded).unwrap();
            assert!(replayed == expected, "{}: replay", codec.name);
            println!(
                "  {}: {} bytes, encode {}, decode {}, replay {}",
                codec.name,
                bytes.len(),
                time(runs.max(50), || (codec.encode_entry)(&entry)).us(),
                time(runs.max(50), || (codec.decode_entry)(&bytes).unwrap()).us(),
                replay.us(),
            );
        }
    }
    // Rebuild: the snapshot, then 1 000 one-node commits (a different leaf each time, as a long editing session).
    let keys = leaves(&model, 1000);
    let mut live = fresh();
    let mut current = model.clone();
    let mut entries = Vec::with_capacity(keys.len());
    let mut json = 0;
    for (i, key) in keys.iter().enumerate() {
        let patch = move_patch(&current, std::slice::from_ref(key), 1.0, (i % 7) as f64);
        json += serde_json::to_string(&patch).unwrap().len();
        patch.apply(&mut current);
        entries.push(live.commit(&patch));
    }
    println!(
        "rebuild from snapshot + {} one-node entries (JSON patches {} bytes in all):",
        entries.len(),
        json
    );
    for codec in codecs() {
        let snapshot = (codec.encode)(&doc);
        let records: Vec<Vec<u8>> = entries
            .iter()
            .map(|entry| (codec.encode_entry)(entry))
            .collect();
        let total: usize = records.iter().map(Vec::len).sum();
        let rebuild = || {
            let mut doc = (codec.decode)(&snapshot).unwrap();
            for record in &records {
                doc.replay(&(codec.decode_entry)(record).unwrap()).unwrap();
            }
            doc
        };
        assert!(rebuild() == live, "{}: rebuild", codec.name);
        let entries_only = time_with(
            runs,
            || (codec.decode)(&snapshot).unwrap(),
            |mut doc| {
                for record in &records {
                    doc.replay(&(codec.decode_entry)(record).unwrap()).unwrap();
                }
                doc
            },
        );
        println!(
            "  {}: snapshot {} bytes + journal {} bytes ({:.0} B/entry); decode snapshot + replay all {}; \
             of which decode + replay of the entries {}",
            codec.name,
            snapshot.len(),
            total,
            total as f64 / records.len() as f64,
            time(runs, rebuild).ms(),
            entries_only.ms(),
        );
    }
}

// ── Hostile input ────────────────────────────────────────────────────────────────────────────────

/// splitmix64: a seeded generator with no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound.max(1) as u64) as usize
    }
}

/// A damaged copy of `frame`: flipped bytes, a cut, an overwritten word, a byte added or dropped, or a spliced run.
/// The 8-byte header is left alone so the payload decoder is what is exercised.
fn damage(frame: &[u8], rng: &mut Rng) -> Vec<u8> {
    let mut out = frame.to_vec();
    let header = 8.min(out.len());
    let at = |rng: &mut Rng, len: usize| header + rng.below(len - header);
    match rng.below(6) {
        0 => {
            for _ in 0..1 + rng.below(4) {
                let i = at(rng, out.len());
                out[i] ^= 1 + rng.below(255) as u8;
            }
        }
        1 => out.truncate(header + rng.below(out.len() - header)),
        2 => {
            let i = at(rng, out.len().saturating_sub(4).max(header + 1));
            let word: u32 = match rng.below(4) {
                0 => u32::MAX,
                1 => 0x7fff_ffff,
                2 => rng.next() as u32,
                _ => rng.below(1 << 16) as u32,
            };
            for (k, byte) in word.to_le_bytes().iter().enumerate() {
                if let Some(slot) = out.get_mut(i + k) {
                    *slot = *byte;
                }
            }
        }
        3 => {
            let i = at(rng, out.len());
            out.insert(i, rng.next() as u8);
        }
        4 => {
            let i = at(rng, out.len());
            out.remove(i);
        }
        _ => {
            let len = 1 + rng.below(64);
            let from = at(rng, out.len());
            let to = at(rng, out.len());
            let run: Vec<u8> = out[from..(from + len).min(out.len())].to_vec();
            for (k, byte) in run.into_iter().enumerate() {
                if let Some(slot) = out.get_mut(to + k) {
                    *slot = byte;
                }
            }
        }
    }
    out
}

#[derive(Default)]
struct Tally {
    decoded: usize,
    refused: usize,
    panicked: usize,
    first_panic: Option<String>,
}

impl Tally {
    fn record(&mut self, outcome: std::thread::Result<bool>) {
        match outcome {
            Ok(true) => self.decoded += 1,
            Ok(false) => self.refused += 1,
            Err(payload) => {
                self.panicked += 1;
                if self.first_panic.is_none() {
                    self.first_panic = Some(
                        payload
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_default(),
                    );
                }
            }
        }
    }

    fn line(&self) -> String {
        format!(
            "decoded {}, refused {}, panicked {}{}",
            self.decoded,
            self.refused,
            self.panicked,
            self.first_panic
                .as_ref()
                .map(|message| format!(" (first: {message})"))
                .unwrap_or_default()
        )
    }
}

fn fuzz(path: &str, iterations: usize, seed: u64) {
    let model = from_json_validated(&read(path)).expect("a valid document");
    let doc = Document::from_model(&model);
    std::panic::set_hook(Box::new(|_| {}));
    println!(
        "file {path}: {} nodes, {iterations} damaged frames per codec, seed {seed}",
        doc.len()
    );
    // A journal entry to damage too: 5 new nodes and a move, replayed on the document it follows.
    let mut patch = add_patch(&model, 5);
    let moved = move_patch(&model, &leaves(&model, 1), 3.0, 4.0);
    patch.nodes.as_mut().unwrap().extend(moved.nodes.unwrap());
    let entry = doc.clone().commit(&patch);
    for codec in codecs() {
        let frame = (codec.encode)(&doc);
        let mut rng = Rng(seed);
        let mut tally = Tally::default();
        let start = Instant::now();
        for _ in 0..iterations {
            let damaged = damage(&frame, &mut rng);
            // A decoded document must also convert back to the JSON model (every symbol resolves).
            tally.record(catch_unwind(AssertUnwindSafe(|| {
                match (codec.decode)(&damaged) {
                    Ok(decoded) => {
                        black_box(decoded.to_model());
                        true
                    }
                    Err(_) => false,
                }
            })));
        }
        println!(
            "{} snapshot ({} bytes): {} in {:.1} s",
            codec.name,
            frame.len(),
            tally.line(),
            start.elapsed().as_secs_f64()
        );
        let record = (codec.encode_entry)(&entry);
        let mut rng = Rng(seed ^ 0x5eed);
        let mut tally = Tally::default();
        let start = Instant::now();
        for _ in 0..iterations {
            let damaged = damage(&record, &mut rng);
            tally.record(catch_unwind(AssertUnwindSafe(|| {
                match (codec.decode_entry)(&damaged) {
                    Ok(decoded) => {
                        let mut replayed = doc.clone();
                        if replayed.replay(&decoded).is_ok() {
                            black_box(replayed.to_model());
                        }
                        true
                    }
                    Err(_) => false,
                }
            })));
        }
        println!(
            "{} journal entry ({} bytes): {} in {:.1} s",
            codec.name,
            record.len(),
            tally.line(),
            start.elapsed().as_secs_f64()
        );
    }
}

// ── Frames for the compression measurements ──────────────────────────────────────────────────────

fn frames(path: &str, dir: &str) {
    let model = from_json_validated(&read(path)).expect("a valid document");
    let doc = Document::from_model(&model);
    let stem = std::path::Path::new(path)
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(dir).unwrap();
    let write = |extension: &str, bytes: &[u8]| {
        let out = format!("{dir}/{stem}.{extension}");
        std::fs::write(&out, bytes).unwrap();
        println!("{out}: {} bytes", bytes.len());
    };
    write("json", to_json(&model).as_bytes());
    for codec in codecs() {
        write(codec.name, &(codec.encode)(&doc));
    }
}

fn profile(path: &str, name: &str, times: usize) {
    let model = from_json_validated(&read(path)).expect("a valid document");
    let doc = Document::from_model(&model);
    let codec = codecs()
        .into_iter()
        .find(|codec| codec.name == name)
        .expect("a codec of this build");
    let bytes = (codec.encode)(&doc);
    drop((model, doc));
    let start = Instant::now();
    for _ in 0..times {
        black_box((codec.decode)(&bytes).unwrap());
    }
    println!(
        "{name}: {:.2} ms per decode",
        start.elapsed().as_secs_f64() * 1e3 / times as f64
    );
}
