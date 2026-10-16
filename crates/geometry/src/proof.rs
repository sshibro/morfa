//! Lane S2's proof module for the engine switch: `localMatrix` and `worldBox` of `shared/design/geometry.ts`, read
//! from the shadow document (`store::Document`), over lane L1's `matrix` module (V8's sin/cos bit for bit): the
//! operations are TypeScript's, in TypeScript's order, so both engines give the same bits.

use morfa_model::NodeType;
use morfa_model::store::Document;

use crate::matrix::{self, Placement, Rect};

/// `[[a, c, e], [b, d, f]]` of types.ts `Matrix`, row by row: `[a, c, e, b, d, f]`.
pub type Matrix = [f64; 6];

pub const IDENTITY: Matrix = flat(&matrix::IDENTITY);

const fn flat(m: &morfa_model::Matrix) -> Matrix {
    [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]]
}

const fn rows(m: &Matrix) -> morfa_model::Matrix {
    [[m[0], m[1], m[2]], [m[3], m[4], m[5]]]
}

pub fn multiply(m: &Matrix, n: &Matrix) -> Matrix {
    flat(&matrix::multiply(&rows(m), &rows(n)))
}

/// translate(x, y) · rotate(−rotation°) · flip about the box centre (`matrix::local_matrix`, V8's sin/cos).
pub fn local_matrix(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    flip_x: bool,
    flip_y: bool,
) -> Matrix {
    flat(&matrix::local_matrix(&Placement {
        x,
        y,
        width,
        height,
        rotation,
        flip_x,
        flip_y,
    }))
}

/// Node local box → page space; pages (and a missing node) are the identity.
pub fn world_matrix(doc: &Document, key: &str) -> Matrix {
    let mut chain = Vec::new();
    let mut at = doc.id(key).and_then(|id| doc.node(id));
    while let Some(node) = at.filter(|node| node.kind != NodeType::Page) {
        chain.push(node);
        at = node.parent.and_then(|parent| doc.node(parent));
    }
    let flip = |value: Option<&bool>| value.copied().unwrap_or(false);
    let m = chain.iter().rev().fold(matrix::IDENTITY, |m, node| {
        let local = matrix::local_matrix(&Placement {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            flip_x: flip(node.props.flip_x()),
            flip_y: flip(node.props.flip_y()),
        });
        matrix::multiply(&m, &local)
    });
    flat(&m)
}

/// The node's box in page space, axis-aligned: `[x, y, width, height]` (`matrix::world_box`).
pub fn world_box(doc: &Document, key: &str) -> [f64; 4] {
    let node = doc.id(key).and_then(|id| doc.node(id));
    let (width, height) = node.map_or((0.0, 0.0), |node| (node.width, node.height));
    let r = matrix::transform_rect(
        &rows(&world_matrix(doc, key)),
        &Rect::new(0.0, 0.0, width, height),
    );
    [r.x, r.y, r.width, r.height]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_box_is_a_translation() {
        assert_eq!(
            local_matrix(3.0, 4.0, 10.0, 20.0, 0.0, false, false),
            [1.0, -0.0, 3.0, 0.0, 1.0, 4.0]
        );
    }

    #[test]
    fn flips_turn_about_the_centre() {
        let m = local_matrix(0.0, 0.0, 10.0, 20.0, 0.0, true, false);
        assert_eq!((m[0], m[2], m[4], m[5]), (-1.0, 10.0, 1.0, 0.0));
    }
}
