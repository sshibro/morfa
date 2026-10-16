//! `src/design/engine/render/spatial-index.ts`, its pure part: the uniform grid (256 px cells, items
//! covering more than 64 cells in a list every query checks), `store`/`remove`/`query` with the same cell
//! arithmetic, and `boxBounds`. Items are `u32` handles (the TS keys entries by node id; a caller maps ids
//! to handles). What the TS class computes per node (bounds.ts render bounds, text layout, the painter's
//! `sameLook`) and its identity diffing between immutable documents stay in TypeScript: they read JS
//! objects the WASM side does not see (STATUS "left in TS").

use hashbrown::{HashMap, HashSet};

use morfa_model::Matrix;

use crate::js;
use crate::matrix::Rect;

const CELL: f64 = 256.0;
/// Items covering more cells than this live in a list every query checks instead of the grid.
const BIG_CELLS: f64 = 64.0;

#[derive(Debug, Clone, Default)]
struct Entry {
    rect: Option<Rect>,
    keys: Option<Vec<(i64, i64)>>,
}

/// The grid of one page.
#[derive(Debug, Clone, Default)]
pub struct Grid {
    entries: HashMap<u32, Entry>,
    /// Insertion order of `entries`, as a JS Map iterates (holes for removed handles).
    order: Vec<u32>,
    grid: HashMap<(i64, i64), Vec<u32>>,
    big: Vec<u32>,
    big_set: HashSet<u32>,
}

#[inline]
fn cell_of(v: f64) -> f64 {
    (v / CELL).floor()
}

#[inline]
fn meets(a: &Rect, b: &Rect) -> bool {
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

impl Grid {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        *self = Grid::default();
    }

    pub fn bounds(&self, id: u32) -> Option<Rect> {
        self.entries.get(&id).and_then(|e| e.rect)
    }

    /// Stores a node's bounds (`store`): only the bounds change while it stays in the same cells.
    pub fn store(&mut self, id: u32, rect: Option<Rect>) {
        if let (Some(old), Some(r)) = (self.entries.get(&id).and_then(|e| e.rect), rect) {
            if old.x == r.x && old.y == r.y && old.width == r.width && old.height == r.height {
                return;
            }
            if (r.x + r.y + r.width + r.height).is_finite()
                && cell_of(old.x) == cell_of(r.x)
                && cell_of(old.y) == cell_of(r.y)
                && cell_of(old.x + old.width) == cell_of(r.x + r.width)
                && cell_of(old.y + old.height) == cell_of(r.y + r.height)
            {
                if let Some(e) = self.entries.get_mut(&id) {
                    e.rect = Some(r);
                }
                return;
            }
        }
        self.unlink(id);
        let mut entry = Entry { rect, keys: None };
        match rect {
            Some(r) if (r.x + r.y + r.width + r.height).is_finite() => {
                let (x0, y0, x1, y1) = (
                    cell_of(r.x),
                    cell_of(r.y),
                    cell_of(r.x + r.width),
                    cell_of(r.y + r.height),
                );
                if (x1 - x0 + 1.0) * (y1 - y0 + 1.0) > BIG_CELLS {
                    if self.big_set.insert(id) {
                        self.big.push(id);
                    }
                } else {
                    let mut keys = Vec::new();
                    let mut cx = x0;
                    while cx <= x1 {
                        let mut cy = y0;
                        while cy <= y1 {
                            let key = (cx as i64, cy as i64);
                            let cell = self.grid.entry(key).or_default();
                            if !cell.contains(&id) {
                                cell.push(id);
                            }
                            keys.push(key);
                            cy += 1.0;
                        }
                        cx += 1.0;
                    }
                    entry.keys = Some(keys);
                }
            }
            _ => entry.rect = None,
        }
        if !self.entries.contains_key(&id) {
            self.order.push(id);
        }
        self.entries.insert(id, entry);
    }

    fn unlink(&mut self, id: u32) {
        let Some(entry) = self.entries.get(&id) else {
            return;
        };
        if self.big_set.remove(&id) {
            self.big.retain(|&b| b != id);
        }
        for key in entry.keys.clone().unwrap_or_default() {
            if let Some(cell) = self.grid.get_mut(&key) {
                cell.retain(|&c| c != id);
                if cell.is_empty() {
                    self.grid.remove(&key);
                }
            }
        }
    }

    pub fn remove(&mut self, id: u32) {
        self.unlink(id);
        if self.entries.remove(&id).is_some() {
            self.order.retain(|&o| o != id);
        }
    }

    /// Handles (any depth) whose bounds meet `rect`, in no particular order.
    pub fn query(&self, rect: &Rect) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        let (x0, y0) = (cell_of(rect.x), cell_of(rect.y));
        let (x1, y1) = (cell_of(rect.x + rect.width), cell_of(rect.y + rect.height));
        if (x1 - x0 + 1.0) * (y1 - y0 + 1.0) > self.entries.len() as f64 * 2.0 {
            // A view far larger than the content: checking every entry is cheaper than every cell.
            for id in &self.order {
                if let Some(r) = self.entries.get(id).and_then(|e| e.rect) {
                    if meets(&r, rect) {
                        out.push(*id);
                    }
                }
            }
            return out;
        }
        let mut cx = x0;
        while cx <= x1 {
            let mut cy = y0;
            while cy <= y1 {
                if let Some(cell) = self.grid.get(&(cx as i64, cy as i64)) {
                    for &id in cell {
                        if seen.contains(&id) {
                            continue;
                        }
                        if self
                            .entries
                            .get(&id)
                            .and_then(|e| e.rect)
                            .is_some_and(|r| meets(&r, rect))
                        {
                            seen.insert(id);
                            out.push(id);
                        }
                    }
                }
                cy += 1.0;
            }
            cx += 1.0;
        }
        for &id in &self.big {
            if !seen.contains(&id)
                && self
                    .entries
                    .get(&id)
                    .and_then(|e| e.rect)
                    .is_some_and(|r| meets(&r, rect))
            {
                seen.insert(id);
                out.push(id);
            }
        }
        out
    }
}

/// Page-space bounds of a node's box under its world matrix, without intermediate arrays.
pub fn box_bounds(m: &Matrix, width: f64, height: f64) -> Rect {
    let w = js::max(0.0, width);
    let h = js::max(0.0, height);
    let (ax, cx, by, dy) = (m[0][0] * w, m[0][1] * h, m[1][0] * w, m[1][1] * h);
    let min_x = m[0][2] + js::min(0.0, ax) + js::min(0.0, cx);
    let max_x = m[0][2] + js::max(0.0, ax) + js::max(0.0, cx);
    let min_y = m[1][2] + js::min(0.0, by) + js::min(0.0, dy);
    let max_y = m[1][2] + js::max(0.0, by) + js::max(0.0, dy);
    Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_queries() {
        let mut g = Grid::default();
        g.store(1, Some(Rect::new(10.0, 10.0, 20.0, 20.0)));
        g.store(2, Some(Rect::new(1000.0, 1000.0, 20.0, 20.0)));
        g.store(3, Some(Rect::new(-5000.0, -5000.0, 10000.0, 10000.0)));
        let mut hits = g.query(&Rect::new(15.0, 15.0, 0.0, 0.0));
        hits.sort();
        assert_eq!(hits, vec![1, 3]);
        g.store(1, Some(Rect::new(2000.0, 10.0, 20.0, 20.0)));
        assert_eq!(g.query(&Rect::new(15.0, 15.0, 0.0, 0.0)), vec![3]);
        g.remove(3);
        assert!(g.query(&Rect::new(15.0, 15.0, 0.0, 0.0)).is_empty());
    }
}
