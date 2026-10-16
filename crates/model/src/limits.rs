//! Bounds of one document's fields and hard caps of a whole file: `DESIGN_FIELD_LIMITS`
//! (shared/design/document-limits.ts) and `DESIGN_DOCUMENT_CAPS` (shared/design/limits.ts), or
//! `DESIGN_BIG_FILE_CAPS` with the big-files switch on (`big_files()`, docs/decisions/big-files.md §1).

use std::sync::atomic::{AtomicU8, Ordering};

/// `DESIGN_FIELD_LIMITS`. String lengths are in UTF-16 code units, as JavaScript counts them.
pub mod field {
    /// Node, style, variable, collection, mode and image ids. Instance copies chain ids with ";".
    pub const ID: usize = 512;
    /// Layer, style, variable, page and flow names.
    pub const NAME: usize = 500;
    /// Text node content.
    pub const CHARACTERS: usize = 100_000;
    /// Path commands of one VECTOR node, all its paths together.
    pub const PATH_COMMANDS: usize = 100_000;
    pub const VECTOR_PATHS: usize = 1_000;
    /// Fills or strokes of one node, run or style.
    pub const PAINTS: usize = 100;
    pub const GRADIENT_STOPS: usize = 100;
    pub const EFFECTS: usize = 100;
    pub const DASH_PATTERN: usize = 100;
    pub const EXPORT_SETTINGS: usize = 50;
    pub const REACTIONS: usize = 100;
    pub const ACTIONS: usize = 50;
    pub const LAYOUT_GRIDS: usize = 100;
    /// Rows or columns of a grid auto-layout frame; also the cap of a child's anchors and spans.
    pub const GRID_TRACKS: usize = 1_000;
    pub const GUIDES: usize = 1_000;
    pub const FLOW_STARTING_POINTS: usize = 500;
    pub const TEXT_RUNS: usize = 10_000;
    /// One entry per paragraph.
    pub const LIST_TYPES: usize = 100_001;
    pub const OVERRIDES: usize = 500;
    pub const COMPONENT_PROPERTIES: usize = 500;
    pub const VARIANT_OPTIONS: usize = 500;
    pub const BOUND_VARIABLES: usize = 200;
    pub const PLUGIN_DATA: usize = 100;
    pub const PLUGIN_DATA_VALUE: usize = 10_000;
    /// Notes for developers on one layer.
    pub const ANNOTATIONS: usize = 100;
    /// The layer properties one note shows.
    pub const ANNOTATION_PROPERTIES: usize = 30;
    /// Pinned measurements of one page.
    pub const MEASUREMENTS: usize = 1_000;
    /// Width points of one custom stroke profile.
    pub const WIDTH_POINTS: usize = 1_000;
    /// Board: waypoints of one reshaped connector.
    pub const CONNECTOR_POINTS: usize = 1_000;
    /// Board: columns or rows one table cell spans.
    pub const TABLE_SPAN: usize = 1_000;
    pub const DESCRIPTION: usize = 10_000;
    pub const FONT_FAMILY: usize = 200;
    pub const URL: usize = 2_048;
    pub const SHORT_TEXT: usize = 200;
    pub const STYLES: usize = 10_000;
    pub const IMAGES: usize = 10_000;
    pub const VARIABLE_COLLECTIONS: usize = 1_000;
    pub const VARIABLES: usize = 20_000;
    pub const MODES: usize = 100;
    /// Nesting below a page. Renderers and exporters walk the tree recursively.
    pub const DEPTH: usize = 256;
    /// |x| of every coordinate, size, offset and radius.
    pub const COORDINATE: f64 = 1e9;
}

/// `DESIGN_DOCUMENT_CAPS` (fixed) and `DESIGN_BIG_FILE_CAPS` (the switch on): hard caps of one file, read at check
/// time through [`caps::nodes`], [`caps::bytes`] and [`caps::pages`].
pub mod caps {
    /// `DESIGN_DOCUMENT_CAPS.nodes`.
    pub const NODES: usize = 50_000;
    /// Serialized JSON of one file.
    pub const BYTES: usize = 20 * 1024 * 1024;
    pub const PAGES: usize = 200;

    /// `DESIGN_BIG_FILE_CAPS`: a safety net, not the product limit (that is the memory budget).
    pub mod big {
        pub const NODES: usize = 2_000_000;
        pub const BYTES: usize = 1024 * 1024 * 1024;
        pub const PAGES: usize = 1_000;
    }

    /// The node cap in force.
    pub fn nodes() -> usize {
        if super::big_files() {
            big::NODES
        } else {
            NODES
        }
    }
    /// The byte cap in force.
    pub fn bytes() -> usize {
        if super::big_files() {
            big::BYTES
        } else {
            BYTES
        }
    }
    /// The page cap in force.
    pub fn pages() -> usize {
        if super::big_files() {
            big::PAGES
        } else {
            PAGES
        }
    }
}

/// `shared/design/big-files.ts` `DEFAULT_BIG_FILES`: the coordinator flips both together.
pub const DEFAULT_BIG_FILES: bool = false;

const UNREAD: u8 = 0;
const OFF: u8 = 1;
const ON: u8 = 2;
/// The switch: unread until first asked, then `MORFA_BIG_FILES` (`1`/`0`; absent: the default) or what
/// [`set_big_files`] pinned. In wasm there is no environment: the default, until the JavaScript side sets it
/// (`crates/wasm` `set_big_files`, from `shared/design/big-files.ts`).
static BIG_FILES: AtomicU8 = AtomicU8::new(UNREAD);

/// Whether documents past the fixed cap are accepted (docs/decisions/big-files.md §1).
pub fn big_files() -> bool {
    match BIG_FILES.load(Ordering::Relaxed) {
        ON => true,
        OFF => false,
        _ => {
            let on = read_env().unwrap_or(DEFAULT_BIG_FILES);
            BIG_FILES.store(if on { ON } else { OFF }, Ordering::Relaxed);
            on
        }
    }
}

/// Pins the switch (`Some`) or reads the environment again on the next call (`None`). Tests that pin it run in
/// their own test binary: the switch is process-wide.
pub fn set_big_files(on: Option<bool>) {
    BIG_FILES.store(
        match on {
            Some(true) => ON,
            Some(false) => OFF,
            None => UNREAD,
        },
        Ordering::Relaxed,
    );
}

#[cfg(not(target_arch = "wasm32"))]
fn read_env() -> Option<bool> {
    match std::env::var("MORFA_BIG_FILES").ok()?.trim() {
        "1" | "true" | "on" => Some(true),
        "0" | "false" | "off" | "" => Some(false),
        other => panic!("MORFA_BIG_FILES is '{other}'; expected 1 or 0"),
    }
}

#[cfg(target_arch = "wasm32")]
fn read_env() -> Option<bool> {
    None
}
