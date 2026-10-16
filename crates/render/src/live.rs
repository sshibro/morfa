//! The live layer's roots (`paintDetached` of scene-renderer.ts): nodes painted outside the tree walk, each with its
//! ancestors' opacity and, unless lifted, their clips.

use crate::bounds::clips_children;
use crate::doc::RenderDoc;
use crate::painter::{Painter, Target};
use crate::shape::shape_of;
use crate::sink::{Clip, Sink};
use morfa_model::NodeType;
use morfa_model::store::Id;
use peniko::{BlendMode, Compose, Mix};

const NORMAL: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::SrcOver,
};

/// Paints `roots` with their ancestors' opacity and (when `clipped`) clips.
pub fn paint_detached(
    painter: &Painter<'_>,
    sink: &mut dyn Sink,
    target: &Target,
    doc: &RenderDoc,
    roots: &[Id],
    clipped: bool,
) {
    let document = doc.document();
    for &id in roots {
        let Some(node) = document.node(id) else {
            continue;
        };
        let mut opacity = 1.0;
        let mut clips: Vec<Id> = Vec::new();
        let mut parent = node.parent.and_then(|p| document.node(p));
        while let Some(p) = parent {
            if p.kind == NodeType::Page {
                break;
            }
            opacity *= p.opacity;
            if clipped && clips_children(p) {
                clips.push(p.id);
            }
            parent = p.parent.and_then(|q| document.node(q));
        }
        let mut pushed = 0;
        for clip_id in &clips {
            let Some(clip_node) = document.node(*clip_id) else {
                continue;
            };
            let Some(shape) = shape_of(clip_node) else {
                continue;
            };
            let (path, rule) = &shape.parts[0];
            let t = target.base * doc.world_matrix(*clip_id);
            sink.push_layer(
                NORMAL,
                1.0,
                Some(Clip {
                    transform: t,
                    rule: *rule,
                    path,
                }),
            );
            pushed += 1;
        }
        painter.paint_root(sink, target, id, opacity);
        for _ in 0..pushed {
            sink.pop_layer();
        }
    }
}
