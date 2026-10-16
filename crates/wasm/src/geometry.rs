//! Geometry entry points (lane L1's module; `localMatrix`/`worldBox` are lane S2's proof, `crates/geometry/src/proof.rs`).
//! Matrices cross as six numbers `[a, c, e, b, d, f]`, rectangles as four `[x, y, width, height]`.

use crate::doc::MorfaDoc;
use crate::fault;
use crate::scratch;
use wasm_bindgen::prelude::*;

/// `localMatrix(node)` of shared/design/geometry.ts from the node's seven placement fields.
#[wasm_bindgen]
pub fn geometry_local_matrix(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    flip_x: bool,
    flip_y: bool,
) -> Vec<f64> {
    let mut m = morfa_geometry::proof::local_matrix(x, y, width, height, rotation, flip_x, flip_y);
    if fault::is_on("geometry.localMatrix") {
        m[2] += 1.0;
    }
    m.to_vec()
}

/// `geometry_local_matrix` written into the scratch buffer (`[a, c, e, b, d, f]`): the switch's hot path.
#[wasm_bindgen]
pub fn geometry_local_matrix_into(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    flip_x: bool,
    flip_y: bool,
) {
    scratch::write(&geometry_local_matrix(
        x, y, width, height, rotation, flip_x, flip_y,
    ));
}

#[wasm_bindgen]
impl MorfaDoc {
    /// `geometry_world_box` written into the scratch buffer (`[x, y, width, height]`).
    pub fn geometry_world_box_into(&self, id: &str) {
        scratch::write(&self.geometry_world_box(id));
    }

    /// `worldBox(doc, id)` of shared/design/geometry.ts on the shadow document.
    pub fn geometry_world_box(&self, id: &str) -> Vec<f64> {
        let mut rect = morfa_geometry::proof::world_box(self.document(), id);
        if fault::is_on("geometry.worldBox") {
            rect[3] *= 2.0;
        }
        rect.to_vec()
    }

    /// `geometry_world_matrix` written into the scratch buffer (`[a, c, e, b, d, f]`).
    pub fn geometry_world_matrix_into(&self, id: &str) {
        let mut m = morfa_geometry::proof::world_matrix(self.document(), id);
        if fault::is_on("geometry.worldMatrix") {
            m[2] += 1.0;
        }
        scratch::write(&m);
    }

    /// `worldMatrix(doc, id)` of shared/design/geometry.ts on the shadow document.
    pub fn geometry_world_matrix(&self, id: &str) -> Vec<f64> {
        morfa_geometry::proof::world_matrix(self.document(), id).to_vec()
    }
}
