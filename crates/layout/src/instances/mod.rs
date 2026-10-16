//! Lane N1: the instance and variable stages (components.ts, variants.ts, variables.ts) on the store's own nodes,
//! ported from lane L2c. Copies take their main's shared values (`Arc`s) instead of copies of them; equality
//! compares shared values by pointer first; strings are resolved only where the TypeScript compares strings
//! (names, override paths, variant names).

pub mod fields;
pub mod geom;
pub mod overrides;
pub mod stage;
pub mod sync;
pub mod variables;
pub mod variants;

use morfa_model::store::Node;

use geom::Placed;

/// The fields `localMatrix` reads, from a stored node.
#[inline]
pub fn placed(node: &Node) -> Placed {
    Placed {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        flip_x: node.props.flip_x() == Some(&true),
        flip_y: node.props.flip_y() == Some(&true),
    }
}
