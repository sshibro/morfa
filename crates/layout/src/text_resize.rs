//! Text that sizes itself (`autoResizeText` of `shared/design/normalize.ts`) on store nodes: the twin of
//! `crate::text_resize`.

use morfa_model::draft::same_f64;
use morfa_model::store::draft::Working;
use morfa_model::store::{Id, Node};
use morfa_model::types::{LayoutPositioning, NodeType, TextAlignHorizontal, TextAutoResize};

use crate::geom::{self, Vec2};
use crate::text::{TextMeasure, TextNode};
use crate::{parent_flow, placement};

/// `inFlow`: visible, not absolute, in an auto-layout frame (layout measures such text itself).
pub fn in_flow(draft: &Working, node: &Node) -> bool {
    node.visible
        && node.layout_positioning != LayoutPositioning::Absolute
        && parent_flow(draft, node)
}

/// Resizes an auto-resizing text to its content. Returns whether it wrote.
pub fn auto_resize_text(draft: &mut Working, id: Id, text: &mut TextMeasure) -> bool {
    let Some(node) = draft.node(id) else {
        return false;
    };
    let Some(props) = node.props.text() else {
        return false;
    };
    let mode = props.text_auto_resize;
    if mode != TextAutoResize::WidthAndHeight && mode != TextAutoResize::Height {
        return false;
    }
    let Some(measured) = TextNode::of(node) else {
        return false;
    };
    let (width, height) = text.box_size(draft, measured);
    if same_f64(width, node.width) && same_f64(height, node.height) {
        return false;
    }
    let anchor = if mode == TextAutoResize::WidthAndHeight {
        match props.text_align_horizontal {
            TextAlignHorizontal::Center => 0.5,
            TextAlignHorizontal::Right => 1.0,
            TextAlignHorizontal::Left | TextAlignHorizontal::Justified => 0.0,
        }
    } else {
        0.0
    };
    let placement = placement(node);
    let fixed = geom::apply(
        &geom::local_matrix(&placement),
        Vec2 {
            x: node.width * anchor,
            y: 0.0,
        },
    );
    let moved = geom::apply(
        &geom::local_matrix(&placement.with_box(0.0, 0.0, width, height)),
        Vec2 {
            x: width * anchor,
            y: 0.0,
        },
    );
    let (x, y) = (fixed.x - moved.x, fixed.y - moved.y);
    draft.update(id, |node| {
        node.x = x;
        node.y = y;
        node.width = width;
        node.height = height;
    })
}

/// Step 1 of normalize: every text among `ids` that sizes itself and is not in a flow. Returns how many were
/// resized (`stats.textResized`).
pub fn resize_texts(
    draft: &mut Working,
    ids: impl IntoIterator<Item = Id>,
    text: &mut TextMeasure,
) -> u64 {
    let mut resized = 0;
    for id in ids {
        let Some(node) = draft.node(id) else {
            continue;
        };
        if node.kind == NodeType::Text && !in_flow(draft, node) && auto_resize_text(draft, id, text)
        {
            resized += 1;
        }
    }
    resized
}
