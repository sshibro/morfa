//! Lane L1's differential harness entries (feature `harness`): every TypeScript function of
//! shared/design/{geometry,paths,shapes,boolean,outline-stroke}.ts and src/design/engine/hit-test.ts one call
//! each, documents parsed from JSON (a handle per document), hit testing and the spatial grid. Built by
//! scripts/geometry/build.sh into scripts/geometry/pkg; the adapters are scripts/geometry/wasm-geometry.ts. The
//! editor's module leaves all of this out (lib.rs).

use std::cell::RefCell;

use morfa_geometry::hit_test::{self, HitCaches, HitScene};
use morfa_geometry::matrix::{self, Placement, Rect};
use morfa_geometry::outline;
use morfa_geometry::paths::{self, ArcPiece};
use morfa_geometry::spatial::Grid;
use morfa_geometry::{boolean, shapes};
use morfa_model::{ArcData, DesignDocument, SceneNode, Vec2};
use wasm_bindgen::prelude::*;

use crate::encode::{
    Reader, decode_commands, decode_paths, encode_commands, encode_matrix, encode_paths,
    encode_polylines, encode_rect, matrix_of, rect_of,
};

fn parse_node(json: &str) -> Option<SceneNode> {
    serde_json::from_str(json).ok()
}

// ── geometry.ts ────────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn multiply(m: &[f64], n: &[f64]) -> Vec<f64> {
    encode_matrix(&matrix::multiply(&matrix_of(m), &matrix_of(n)))
}

#[wasm_bindgen]
pub fn invert(m: &[f64]) -> Vec<f64> {
    encode_matrix(&matrix::invert(&matrix_of(m)))
}

#[wasm_bindgen(js_name = localMatrix)]
pub fn local_matrix(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    flip_x: bool,
    flip_y: bool,
) -> Vec<f64> {
    encode_matrix(&matrix::local_matrix(&Placement {
        x,
        y,
        width,
        height,
        rotation,
        flip_x,
        flip_y,
    }))
}

#[wasm_bindgen(js_name = transformRect)]
pub fn transform_rect(m: &[f64], r: &[f64]) -> Vec<f64> {
    encode_rect(Some(matrix::transform_rect(&matrix_of(m), &rect_of(r))))
}

#[wasm_bindgen(js_name = boundsOfPoints)]
pub fn bounds_of_points(xy: &[f64]) -> Vec<f64> {
    let points: Vec<Vec2> = xy
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| Vec2 { x: p[0], y: p[1] })
        .collect();
    encode_rect(Some(matrix::bounds_of_points(&points)))
}

#[wasm_bindgen(js_name = unionRects)]
pub fn union_rects(rects: &[f64]) -> Vec<f64> {
    let rects: Vec<Rect> = rects
        .as_chunks::<4>()
        .0
        .iter()
        .map(|r| rect_of(r))
        .collect();
    encode_rect(matrix::union_rects(&rects))
}

#[wasm_bindgen]
pub fn decompose(m: &[f64]) -> Vec<f64> {
    let d = matrix::decompose(&matrix_of(m));
    vec![
        d.x,
        d.y,
        d.rotation,
        d.scale_x,
        d.scale_y,
        if d.flip_x { 1.0 } else { 0.0 },
    ]
}

// ── paths.ts ───────────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = parsePathData)]
pub fn parse_path_data(d: &str, max_commands: f64) -> Vec<f64> {
    let max = if max_commands.is_finite() && max_commands >= 0.0 {
        Some(max_commands as usize)
    } else {
        None
    };
    encode_commands(&paths::parse_path_data(d, max))
}

#[wasm_bindgen(js_name = serializePathData)]
pub fn serialize_path_data(commands: &[f64], precision: i32) -> String {
    paths::serialize_path_data(&decode_commands(commands), precision)
}

#[wasm_bindgen(js_name = formatNumber)]
pub fn format_number(value: f64, precision: i32) -> String {
    paths::format_number(value, precision)
}

#[wasm_bindgen(js_name = transformPath)]
pub fn transform_path(commands: &[f64], m: &[f64]) -> Vec<f64> {
    encode_commands(&paths::transform_path(
        &decode_commands(commands),
        &matrix_of(m),
    ))
}

#[wasm_bindgen(js_name = pathBounds)]
pub fn path_bounds(commands: &[f64]) -> Vec<f64> {
    encode_rect(paths::path_bounds(&decode_commands(commands)))
}

#[wasm_bindgen(js_name = pathsBounds)]
pub fn paths_bounds(paths: &[f64]) -> Vec<f64> {
    encode_rect(paths::paths_bounds(&decode_paths(paths)))
}

#[wasm_bindgen(js_name = flattenPath)]
pub fn flatten_path(commands: &[f64], tolerance: f64, max_angle: f64, max_points: f64) -> Vec<f64> {
    let max_points = if max_points.is_finite() && max_points >= 0.0 {
        Some(max_points as usize)
    } else {
        None
    };
    encode_polylines(&paths::flatten_path(
        &decode_commands(commands),
        tolerance,
        max_angle,
        max_points,
    ))
}

/// `flattenPath` of many paths in one call: `paths` encoded as a paths list (winding ignored); the answer is the
/// path count, then per path its encoded polylines.
#[wasm_bindgen(js_name = flattenPaths)]
pub fn flatten_paths(paths: &[f64], tolerance: f64, max_angle: f64) -> Vec<f64> {
    let list = decode_paths(paths);
    let mut out = vec![list.len() as f64];
    for p in &list {
        out.extend(encode_polylines(&paths::flatten_path(
            &p.commands,
            tolerance,
            max_angle,
            None,
        )));
    }
    out
}

/// [count, then per piece: 2 (line, 2 points) or 4 (cubic, 4 points), x, y…].
#[wasm_bindgen(js_name = svgArcToCubics)]
#[allow(clippy::too_many_arguments)]
pub fn svg_arc_to_cubics(
    fx: f64,
    fy: f64,
    rx: f64,
    ry: f64,
    rotation: f64,
    large_arc: bool,
    sweep: bool,
    tx: f64,
    ty: f64,
) -> Vec<f64> {
    let pieces = paths::svg_arc_to_cubics(
        Vec2 { x: fx, y: fy },
        rx,
        ry,
        rotation,
        large_arc,
        sweep,
        Vec2 { x: tx, y: ty },
    );
    let mut out = vec![pieces.len() as f64];
    for piece in pieces {
        match piece {
            ArcPiece::Line(a, b) => out.extend([2.0, a.x, a.y, b.x, b.y]),
            ArcPiece::Cubic(c) => {
                out.push(4.0);
                for p in c {
                    out.extend([p.x, p.y]);
                }
            }
        }
    }
    out
}

fn encode_cubics(cubics: &[paths::Cubic]) -> Vec<f64> {
    let mut out = Vec::with_capacity(cubics.len() * 8);
    for c in cubics {
        for p in c {
            out.extend([p.x, p.y]);
        }
    }
    out
}

fn cubic_of(c: &[f64]) -> paths::Cubic {
    [
        Vec2 { x: c[0], y: c[1] },
        Vec2 { x: c[2], y: c[3] },
        Vec2 { x: c[4], y: c[5] },
        Vec2 { x: c[6], y: c[7] },
    ]
}

#[wasm_bindgen(js_name = ellipseArcCubics)]
pub fn ellipse_arc_cubics(
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    rotation: f64,
    start: f64,
    sweep: f64,
) -> Vec<f64> {
    encode_cubics(&paths::ellipse_arc_cubics(
        Vec2 { x: cx, y: cy },
        rx,
        ry,
        rotation,
        start,
        sweep,
    ))
}

#[wasm_bindgen(js_name = splitCubicAt)]
pub fn split_cubic_at(c: &[f64], t: f64) -> Vec<f64> {
    let (a, b) = paths::split_cubic_at(&cubic_of(c), t);
    encode_cubics(&[a, b])
}

#[wasm_bindgen(js_name = subCubic)]
pub fn sub_cubic(c: &[f64], t0: f64, t1: f64) -> Vec<f64> {
    encode_cubics(&[paths::sub_cubic(&cubic_of(c), t0, t1)])
}

#[wasm_bindgen(js_name = cubicSteps)]
pub fn cubic_steps(c: &[f64], tolerance: f64, max_angle: f64) -> f64 {
    paths::cubic_steps(&cubic_of(c), tolerance, max_angle)
}

/// [count, then per segment: index, subpath, kind (0 line, 1 cubic), p0, c1, c2, p1 (c1/c2 zero for lines)].
#[wasm_bindgen(js_name = pathSegments)]
pub fn path_segments(commands: &[f64], close_open: bool) -> Vec<f64> {
    let segments = paths::path_segments(&decode_commands(commands), close_open);
    let mut out = Vec::with_capacity(1 + segments.len() * 11);
    out.push(segments.len() as f64);
    for s in segments {
        let [c1, c2] = s.controls.unwrap_or([Vec2 { x: 0.0, y: 0.0 }; 2]);
        out.extend([
            s.index as f64,
            s.subpath as f64,
            if s.is_cubic() { 1.0 } else { 0.0 },
            s.p0.x,
            s.p0.y,
            c1.x,
            c1.y,
            c2.x,
            c2.y,
            s.p1.x,
            s.p1.y,
        ]);
    }
    out
}

#[wasm_bindgen(js_name = reversePath)]
pub fn reverse_path(commands: &[f64]) -> Vec<f64> {
    encode_commands(&paths::reverse_path(&decode_commands(commands)))
}

#[wasm_bindgen(js_name = windingNumber)]
pub fn winding_number(commands: &[f64], x: f64, y: f64) -> f64 {
    paths::winding_number(&decode_commands(commands), Vec2 { x, y }) as f64
}

/// [distance, index, t, x, y] or [] for null.
#[wasm_bindgen(js_name = distanceToPath)]
pub fn distance_to_path(commands: &[f64], x: f64, y: f64) -> Vec<f64> {
    paths::distance_to_path(&decode_commands(commands), Vec2 { x, y }).map_or_else(Vec::new, |h| {
        vec![h.distance, h.index as f64, h.t, h.point.x, h.point.y]
    })
}

#[wasm_bindgen(js_name = pathLength)]
pub fn path_length(commands: &[f64]) -> f64 {
    paths::path_length(&decode_commands(commands))
}

#[wasm_bindgen(js_name = fitCubics)]
pub fn fit_cubics(xy: &[f64], tolerance: f64) -> Vec<f64> {
    let points: Vec<Vec2> = xy
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| Vec2 { x: p[0], y: p[1] })
        .collect();
    encode_cubics(&paths::fit_cubics(&points, tolerance))
}

// ── shapes.ts ──────────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = nodeGeometry)]
pub fn node_geometry(node_json: &str) -> Vec<f64> {
    parse_node(node_json).map_or_else(|| vec![-1.0], |n| encode_paths(&shapes::node_geometry(&n)))
}

#[wasm_bindgen(js_name = rectanglePath)]
pub fn rectangle_path(width: f64, height: f64, radii: &[f64], smoothing: f64) -> Vec<f64> {
    let r = [radii[0], radii[1], radii[2], radii[3]];
    encode_commands(&shapes::rectangle_path(width, height, &r, smoothing))
}

#[wasm_bindgen(js_name = ellipsePaths)]
pub fn ellipse_paths(width: f64, height: f64, arc: &[f64]) -> Vec<f64> {
    let arc = (arc.len() == 3).then(|| ArcData {
        starting_angle: arc[0],
        ending_angle: arc[1],
        inner_radius: arc[2],
    });
    encode_paths(&shapes::ellipse_paths(width, height, arc.as_ref()))
}

#[wasm_bindgen(js_name = polygonPath)]
pub fn polygon_path(width: f64, height: f64, point_count: f64, corner_radius: f64) -> Vec<f64> {
    encode_commands(&shapes::polygon_path(
        width,
        height,
        point_count,
        corner_radius,
    ))
}

#[wasm_bindgen(js_name = starPath)]
pub fn star_path(
    width: f64,
    height: f64,
    point_count: f64,
    inner_radius: f64,
    corner_radius: f64,
) -> Vec<f64> {
    encode_commands(&shapes::star_path(
        width,
        height,
        point_count,
        inner_radius,
        corner_radius,
    ))
}

#[wasm_bindgen(js_name = booleanTolerance)]
pub fn boolean_tolerance(width: f64, height: f64) -> f64 {
    boolean::boolean_tolerance(width, height)
}

#[wasm_bindgen(js_name = strokeTolerance)]
pub fn stroke_tolerance(weight: f64) -> f64 {
    outline::stroke_tolerance(weight)
}

/// `geometry`: encoded paths, or [] for the node's own; `tolerance` NaN for the default.
#[wasm_bindgen(js_name = outlineStroke)]
pub fn outline_stroke(node_json: &str, geometry: &[f64], tolerance: f64) -> Vec<f64> {
    let Some(node) = parse_node(node_json) else {
        return vec![-1.0];
    };
    let geometry = (!geometry.is_empty()).then(|| decode_paths(geometry));
    let tolerance = (!tolerance.is_nan()).then_some(tolerance);
    encode_paths(&outline::outline_stroke(
        &node,
        geometry.as_deref(),
        tolerance,
    ))
}

// ── Documents: hit testing, world matrices, booleans of a document ────────────────────────────

struct Loaded {
    doc: Box<DesignDocument>,
    caches: HitCaches,
    /// The index's text measurer: 0 none, 1 `testMeasurer` (`setTextMeasurer`).
    measurer: u32,
}

thread_local! {
    static DOCUMENTS: RefCell<Vec<Option<Loaded>>> = const { RefCell::new(Vec::new()) };
    static GRIDS: RefCell<Vec<Option<Grid>>> = const { RefCell::new(Vec::new()) };
}

/// Loads a document (its JSON) and returns its handle; -1 when it does not parse.
#[wasm_bindgen(js_name = loadDocument)]
pub fn load_document(json: &str) -> i32 {
    let Ok(doc) = morfa_model::from_json(json) else {
        return -1;
    };
    DOCUMENTS.with(|d| {
        let mut docs = d.borrow_mut();
        let loaded = Some(Loaded {
            doc: Box::new(doc),
            caches: HitCaches::default(),
            measurer: 0,
        });
        if let Some(slot) = docs.iter().position(Option::is_none) {
            docs[slot] = loaded;
            slot as i32
        } else {
            docs.push(loaded);
            docs.len() as i32 - 1
        }
    })
}

/// The text measurer of the document's index, as the TypeScript `SpatialIndex` was synced with: 0 none (a text node
/// is its box), 1 `testMeasurer`. A change drops the caches (the index is built again).
#[wasm_bindgen(js_name = setTextMeasurer)]
pub fn set_text_measurer(handle: i32, kind: u32) {
    with_doc(handle, (), |l| {
        if l.measurer != kind {
            l.measurer = kind;
            l.caches = if kind == 1 {
                HitCaches::with_test_measurer()
            } else {
                HitCaches::default()
            };
        }
    });
}

/// Whether the document's index met a node it cannot bound as the TypeScript does (a text on a path, measured).
#[wasm_bindgen(js_name = indexUnsupported)]
pub fn index_unsupported(handle: i32) -> bool {
    with_doc(handle, false, |l| l.caches.unsupported())
}

#[wasm_bindgen(js_name = freeDocument)]
pub fn free_document(handle: i32) {
    DOCUMENTS.with(|d| {
        if let Some(slot) = d.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

fn with_doc<T>(handle: i32, default: T, run: impl FnOnce(&mut Loaded) -> T) -> T {
    DOCUMENTS.with(|d| {
        match d
            .borrow_mut()
            .get_mut(handle as usize)
            .and_then(Option::as_mut)
        {
            Some(loaded) => run(loaded),
            None => default,
        }
    })
}

fn with_scene<T>(
    handle: i32,
    page: &str,
    indexed: bool,
    run: impl FnOnce(&HitScene<'_>) -> T,
    default: T,
) -> T {
    with_doc(handle, default, |loaded| {
        let scene = HitScene::new(&loaded.doc, &loaded.caches);
        if indexed {
            scene.build_index(page);
        }
        run(&scene)
    })
}

#[wasm_bindgen(js_name = worldMatrix)]
pub fn world_matrix(handle: i32, id: &str) -> Vec<f64> {
    with_doc(handle, encode_matrix(&matrix::IDENTITY), |l| {
        encode_matrix(&matrix::world_matrix(&l.doc, id))
    })
}

#[wasm_bindgen(js_name = worldBox)]
pub fn world_box(handle: i32, id: &str) -> Vec<f64> {
    with_doc(handle, Vec::new(), |l| {
        encode_rect(Some(matrix::world_box(&l.doc, id)))
    })
}

#[wasm_bindgen(js_name = booleanGeometry)]
pub fn boolean_geometry(handle: i32, id: &str) -> Vec<f64> {
    with_doc(handle, encode_paths(&[]), |l| {
        encode_paths(&boolean::boolean_geometry(&l.doc, id))
    })
}

/// `flattenPath` of every path of every node of a loaded document (`nodeGeometry`, then flatten), as the shadow
/// document would answer it: node count, then per node its path count and per path its encoded polylines.
#[wasm_bindgen(js_name = flattenDocument)]
pub fn flatten_document(handle: i32, tolerance: f64) -> Vec<f64> {
    with_doc(handle, Vec::new(), |l| {
        let mut out = vec![l.doc.nodes.len() as f64];
        for node in l.doc.nodes.values() {
            let geometry = shapes::node_geometry(node);
            out.push(geometry.len() as f64);
            for p in &geometry {
                out.extend(encode_polylines(&paths::flatten_path(
                    &p.commands,
                    tolerance,
                    0.0,
                    None,
                )));
            }
        }
        out
    })
}

#[wasm_bindgen(js_name = hitTest)]
pub fn hit_test(
    handle: i32,
    page: &str,
    x: f64,
    y: f64,
    tolerance: f64,
    indexed: bool,
) -> Option<String> {
    with_scene(
        handle,
        page,
        indexed,
        |s| {
            s.hit_test(page, Vec2 { x, y }, tolerance, indexed)
                .map(str::to_owned)
        },
        None,
    )
}

/// `pickAt` for many points ([x, y]…) on one scene: one index build, the answers in order ("" for null).
#[wasm_bindgen(js_name = pickMany)]
pub fn pick_many(
    handle: i32,
    page: &str,
    xy: &[f64],
    tolerance: f64,
    indexed: bool,
    context: Option<String>,
    deep: bool,
) -> Vec<String> {
    with_scene(
        handle,
        page,
        indexed,
        |s| {
            xy.as_chunks::<2>()
                .0
                .iter()
                .map(|p| {
                    s.pick_at(
                        page,
                        Vec2 { x: p[0], y: p[1] },
                        tolerance,
                        indexed,
                        context.as_deref(),
                        deep,
                    )
                    .unwrap_or("")
                    .to_owned()
                })
                .collect()
        },
        Vec::new(),
    )
}

#[wasm_bindgen(js_name = pickAt)]
#[allow(clippy::too_many_arguments)]
pub fn pick_at(
    handle: i32,
    page: &str,
    x: f64,
    y: f64,
    tolerance: f64,
    indexed: bool,
    context: Option<String>,
    deep: bool,
) -> Option<String> {
    with_scene(
        handle,
        page,
        indexed,
        |s| {
            s.pick_at(
                page,
                Vec2 { x, y },
                tolerance,
                indexed,
                context.as_deref(),
                deep,
            )
            .map(str::to_owned)
        },
        None,
    )
}

#[wasm_bindgen(js_name = nodesInRect)]
pub fn nodes_in_rect(
    handle: i32,
    page: &str,
    rect: &[f64],
    context: Option<String>,
    scope: Option<String>,
    indexed: bool,
) -> Vec<String> {
    with_scene(
        handle,
        page,
        indexed,
        |s| {
            s.nodes_in_rect(
                page,
                &rect_of(rect),
                context.as_deref(),
                scope.as_deref(),
                indexed,
            )
            .into_iter()
            .map(str::to_owned)
            .collect()
        },
        Vec::new(),
    )
}

#[wasm_bindgen(js_name = hitsNode)]
pub fn hits_node(handle: i32, id: &str, x: f64, y: f64, tolerance: f64) -> bool {
    with_doc(handle, false, |l| {
        HitScene::new(&l.doc, &l.caches).hits_node(id, Vec2 { x, y }, tolerance)
    })
}

#[wasm_bindgen(js_name = flattenCommands)]
pub fn flatten_commands(commands: &[f64]) -> Vec<f64> {
    let lines = hit_test::flatten_commands(&decode_commands(commands));
    let mut out = vec![lines.len() as f64];
    for l in lines {
        out.push(if l.closed { 1.0 } else { 0.0 });
        out.push(l.points.len() as f64);
        out.extend(l.points);
    }
    out
}

#[wasm_bindgen(js_name = nodeOutline)]
pub fn node_outline(node_json: &str) -> Vec<f64> {
    let Some(node) = parse_node(node_json) else {
        return vec![-1.0];
    };
    let lines = hit_test::node_outline(&node);
    let mut out = vec![lines.len() as f64];
    for l in lines {
        out.push(if l.closed { 1.0 } else { 0.0 });
        out.push(l.points.len() as f64);
        out.extend(l.points);
    }
    out
}

#[wasm_bindgen(js_name = boxIntersectsRect)]
pub fn box_intersects_rect(m: &[f64], width: f64, height: f64, rect: &[f64]) -> bool {
    hit_test::box_intersects_rect(&matrix_of(m), width, height, &rect_of(rect))
}

// ── spatial-index.ts grid ──────────────────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = gridNew)]
pub fn grid_new() -> u32 {
    GRIDS.with(|g| {
        let mut grids = g.borrow_mut();
        grids.push(Some(Grid::default()));
        grids.len() as u32 - 1
    })
}

#[wasm_bindgen(js_name = gridStore)]
pub fn grid_store(grid: u32, id: u32, rect: &[f64]) {
    GRIDS.with(|g| {
        if let Some(Some(grid)) = g.borrow_mut().get_mut(grid as usize) {
            grid.store(id, (rect.len() == 4).then(|| rect_of(rect)));
        }
    });
}

#[wasm_bindgen(js_name = gridRemove)]
pub fn grid_remove(grid: u32, id: u32) {
    GRIDS.with(|g| {
        if let Some(Some(grid)) = g.borrow_mut().get_mut(grid as usize) {
            grid.remove(id);
        }
    });
}

#[wasm_bindgen(js_name = gridQuery)]
pub fn grid_query(grid: u32, rect: &[f64]) -> Vec<u32> {
    GRIDS.with(|g| match g.borrow().get(grid as usize) {
        Some(Some(grid)) => grid.query(&rect_of(rect)),
        _ => Vec::new(),
    })
}

#[wasm_bindgen(js_name = gridClear)]
pub fn grid_clear(grid: u32) {
    GRIDS.with(|g| {
        if let Some(Some(grid)) = g.borrow_mut().get_mut(grid as usize) {
            grid.clear();
        }
    });
}

#[wasm_bindgen(js_name = gridFree)]
pub fn grid_free(grid: u32) {
    GRIDS.with(|g| {
        if let Some(slot) = g.borrow_mut().get_mut(grid as usize) {
            *slot = None;
        }
    });
}

/// Whether the reader consumed everything (a guard for the adapters' tests).
#[wasm_bindgen(js_name = decodesPaths)]
pub fn decodes_paths(paths: &[f64]) -> bool {
    let mut r = Reader::new(paths);
    let _ = r.paths();
    r.done()
}
