//! Lossless conversion between the JSON model (`crate::types`, the mirror of types.ts) and the store: every field,
//! every `null` and every absent key survives `Document::from_model` then `to_model`.

use super::journal::Entry;
use super::node::{Prop, Props};
use super::value::*;
use super::{Atom, Document, Id, Interner, List, Node, Symbol};
use crate::patch::DocumentPatch;
use crate::types as t;
use indexmap::IndexMap;
use std::sync::Arc;

/// Where the strings of a value being converted into the store get their symbols: a document's own interners
/// ([`Shared`]), or a working copy's layered ones ([`super::Layer`], `store::draft::Working`).
pub(super) trait Symbols {
    fn id(&mut self, key: &str) -> Id;
    fn atom(&mut self, value: &str) -> Atom;
    fn get_id(&self, key: &str) -> Option<Id>;
    fn get_atom(&self, value: &str) -> Option<Atom>;
}

/// A document's interners. One shared with another version of the document (a kept clone) is copied only when a
/// string is new, not on every commit.
pub(super) struct Shared<'a> {
    pub(super) ids: &'a mut Arc<Interner<Id>>,
    pub(super) atoms: &'a mut Arc<Interner<Atom>>,
}

/// The symbol of `value`, interning it when new; `interner` is copied first only if it is shared and `value` is new.
fn intern_shared<S: Symbol>(interner: &mut Arc<Interner<S>>, value: &str) -> S {
    if let Some(unique) = Arc::get_mut(interner) {
        return unique.intern(value);
    }
    match interner.get(value) {
        Some(symbol) => symbol,
        None => Arc::make_mut(interner).intern(value),
    }
}

impl Symbols for Shared<'_> {
    fn id(&mut self, key: &str) -> Id {
        intern_shared(self.ids, key)
    }

    fn atom(&mut self, value: &str) -> Atom {
        intern_shared(self.atoms, value)
    }

    fn get_id(&self, key: &str) -> Option<Id> {
        self.ids.get(key)
    }

    fn get_atom(&self, value: &str) -> Option<Atom> {
        self.atoms.get(value)
    }
}

/// Interning while converting into the store.
pub(super) struct Interning<'a> {
    pub(super) symbols: &'a mut dyn Symbols,
}

impl<'a> Interning<'a> {
    pub(super) fn new(symbols: &'a mut dyn Symbols) -> Self {
        Interning { symbols }
    }

    fn id(&mut self, key: &str) -> Id {
        self.symbols.id(key)
    }

    fn atom(&mut self, value: &str) -> Atom {
        self.symbols.atom(value)
    }

    fn ids(&mut self, keys: &[String]) -> List<Id> {
        keys.iter().map(|key| self.id(key)).collect()
    }

    fn atoms(&mut self, values: &[String]) -> List<Atom> {
        values.iter().map(|value| self.atom(value)).collect()
    }
}

/// Where symbols resolve while converting back to the JSON model: a document's interners, or a working copy's.
pub trait Resolver {
    fn key(&self, id: Id) -> &str;
    fn atom(&self, atom: Atom) -> &str;
}

impl Resolver for (&Interner<Id>, &Interner<Atom>) {
    fn key(&self, id: Id) -> &str {
        self.0.resolve(id)
    }

    fn atom(&self, atom: Atom) -> &str {
        self.1.resolve(atom)
    }
}

/// Resolving symbols while converting back to the JSON model.
pub(super) struct Resolving<'a> {
    symbols: &'a dyn Resolver,
}

impl<'a> Resolving<'a> {
    pub(super) fn new(symbols: &'a dyn Resolver) -> Self {
        Resolving { symbols }
    }

    fn id(&self, id: Id) -> String {
        self.symbols.key(id).to_owned()
    }

    fn atom(&self, atom: Atom) -> String {
        self.symbols.atom(atom).to_owned()
    }

    fn ids(&self, ids: &[Id]) -> Vec<String> {
        ids.iter().map(|&id| self.id(id)).collect()
    }

    fn atoms(&self, atoms: &[Atom]) -> Vec<String> {
        atoms.iter().map(|&atom| self.atom(atom)).collect()
    }
}

fn text(value: &str) -> Arc<str> {
    Arc::from(value)
}

// ── Paints and effects ───────────────────────────────────────────────────────────────────────────

fn paint_in(paint: &t::Paint, cx: &mut Interning) -> Paint {
    let gradient = |kind: GradientKind, paint: &t::GradientPaint| {
        Paint::Gradient(Box::new(GradientPaint {
            kind,
            opacity: paint.opacity,
            visible: paint.visible,
            blend_mode: paint.blend_mode,
            stops: paint.gradient_stops.clone().into(),
            handles: paint.gradient_handle_positions,
        }))
    };
    match paint {
        t::Paint::Solid(solid) => Paint::Solid(SolidPaint {
            color: solid.color,
            opacity: solid.opacity,
            visible: solid.visible,
            blend_mode: solid.blend_mode,
            bound_color: solid
                .bound_variables
                .as_ref()
                .map(|bound| bound.color.as_ref().map(|alias| cx.atom(&alias.id))),
        }),
        t::Paint::GradientLinear(paint) => gradient(GradientKind::Linear, paint),
        t::Paint::GradientRadial(paint) => gradient(GradientKind::Radial, paint),
        t::Paint::GradientAngular(paint) => gradient(GradientKind::Angular, paint),
        t::Paint::GradientDiamond(paint) => gradient(GradientKind::Diamond, paint),
        t::Paint::Image(image) => Paint::Image(Box::new(ImagePaint {
            opacity: image.opacity,
            visible: image.visible,
            blend_mode: image.blend_mode,
            image_ref: (!image.image_ref.is_empty()).then(|| cx.atom(&image.image_ref)),
            scale_mode: image.scale_mode,
            transform: image.image_transform,
            scaling_factor: image.scaling_factor,
            rotation: image.rotation,
            filters: image.filters.map(|filters| ImageFilters {
                exposure: filters.exposure,
                contrast: filters.contrast,
                saturation: filters.saturation,
                temperature: filters.temperature,
                tint: filters.tint,
                highlights: filters.highlights,
                shadows: filters.shadows,
            }),
        })),
    }
}

fn paint_out(paint: &Paint, cx: &Resolving) -> t::Paint {
    match paint {
        Paint::Solid(solid) => t::Paint::Solid(t::SolidPaint {
            opacity: solid.opacity,
            visible: solid.visible,
            blend_mode: solid.blend_mode,
            color: solid.color,
            bound_variables: solid.bound_color.map(|color| t::SolidPaintBoundVariables {
                color: color.map(|variable| alias(cx, variable)),
            }),
        }),
        Paint::Gradient(gradient) => {
            let paint = t::GradientPaint {
                opacity: gradient.opacity,
                visible: gradient.visible,
                blend_mode: gradient.blend_mode,
                gradient_stops: gradient.stops.to_vec(),
                gradient_handle_positions: gradient.handles,
            };
            match gradient.kind {
                GradientKind::Linear => t::Paint::GradientLinear(paint),
                GradientKind::Radial => t::Paint::GradientRadial(paint),
                GradientKind::Angular => t::Paint::GradientAngular(paint),
                GradientKind::Diamond => t::Paint::GradientDiamond(paint),
            }
        }
        Paint::Image(image) => t::Paint::Image(t::ImagePaint {
            opacity: image.opacity,
            visible: image.visible,
            blend_mode: image.blend_mode,
            image_ref: image
                .image_ref
                .map(|image| cx.atom(image))
                .unwrap_or_default(),
            scale_mode: image.scale_mode,
            image_transform: image.transform,
            scaling_factor: image.scaling_factor,
            rotation: image.rotation,
            filters: image.filters.map(|filters| t::ImageFilters {
                exposure: filters.exposure,
                contrast: filters.contrast,
                saturation: filters.saturation,
                temperature: filters.temperature,
                tint: filters.tint,
                highlights: filters.highlights,
                shadows: filters.shadows,
            }),
        }),
    }
}

fn alias(cx: &Resolving, variable: Atom) -> t::VariableAlias {
    t::VariableAlias {
        kind: t::VariableAliasType::VariableAlias,
        id: cx.atom(variable),
    }
}

pub(super) fn paints_in(paints: &[t::Paint], cx: &mut Interning) -> List<Paint> {
    paints.iter().map(|paint| paint_in(paint, cx)).collect()
}

fn paints_out(paints: &[Paint], cx: &Resolving) -> Vec<t::Paint> {
    paints.iter().map(|paint| paint_out(paint, cx)).collect()
}

fn effect_in(effect: &t::Effect) -> Effect {
    let shadow = |kind, shadow: &t::ShadowEffect| {
        Effect::Shadow(ShadowEffect {
            kind,
            color: shadow.color,
            offset: shadow.offset,
            radius: shadow.radius,
            spread: shadow.spread,
            visible: shadow.visible,
            blend_mode: shadow.blend_mode,
            show_shadow_behind_node: shadow.show_shadow_behind_node,
        })
    };
    let blur = |kind, blur: &t::BlurEffect| {
        Effect::Blur(BlurEffect {
            kind,
            radius: blur.radius,
            visible: blur.visible,
        })
    };
    match effect {
        t::Effect::DropShadow(effect) => shadow(ShadowKind::Drop, effect),
        t::Effect::InnerShadow(effect) => shadow(ShadowKind::Inner, effect),
        t::Effect::LayerBlur(effect) => blur(BlurKind::Layer, effect),
        t::Effect::BackgroundBlur(effect) => blur(BlurKind::Background, effect),
    }
}

fn effect_out(effect: &Effect) -> t::Effect {
    match effect {
        Effect::Shadow(shadow) => {
            let effect = t::ShadowEffect {
                color: shadow.color,
                offset: shadow.offset,
                radius: shadow.radius,
                spread: shadow.spread,
                visible: shadow.visible,
                blend_mode: shadow.blend_mode,
                show_shadow_behind_node: shadow.show_shadow_behind_node,
            };
            match shadow.kind {
                ShadowKind::Drop => t::Effect::DropShadow(effect),
                ShadowKind::Inner => t::Effect::InnerShadow(effect),
            }
        }
        Effect::Blur(blur) => {
            let effect = t::BlurEffect {
                radius: blur.radius,
                visible: blur.visible,
            };
            match blur.kind {
                BlurKind::Layer => t::Effect::LayerBlur(effect),
                BlurKind::Background => t::Effect::BackgroundBlur(effect),
            }
        }
    }
}

pub(super) fn effects_in(effects: &[t::Effect]) -> List<Effect> {
    effects.iter().map(effect_in).collect()
}

fn effects_out(effects: &[Effect]) -> Vec<t::Effect> {
    effects.iter().map(effect_out).collect()
}

fn grid_in(grid: &t::LayoutGrid) -> LayoutGrid {
    match grid {
        t::LayoutGrid::Grid(grid) => LayoutGrid::Grid(grid.clone()),
        t::LayoutGrid::Columns(band) => LayoutGrid::Columns(band.clone()),
        t::LayoutGrid::Rows(band) => LayoutGrid::Rows(band.clone()),
    }
}

fn grid_out(grid: &LayoutGrid) -> t::LayoutGrid {
    match grid {
        LayoutGrid::Grid(grid) => t::LayoutGrid::Grid(grid.clone()),
        LayoutGrid::Columns(band) => t::LayoutGrid::Columns(band.clone()),
        LayoutGrid::Rows(band) => t::LayoutGrid::Rows(band.clone()),
    }
}

fn grids_in(grids: &[t::LayoutGrid]) -> List<LayoutGrid> {
    grids.iter().map(grid_in).collect()
}

fn grids_out(grids: &[LayoutGrid]) -> Vec<t::LayoutGrid> {
    grids.iter().map(grid_out).collect()
}

// ── Grid auto layout ─────────────────────────────────────────────────────────────────────────────

fn track_in(track: &t::GridTrackSize) -> GridTrackSize {
    GridTrackSize {
        kind: track.kind,
        value: track.value,
    }
}

fn track_out(track: &GridTrackSize) -> t::GridTrackSize {
    t::GridTrackSize {
        kind: track.kind,
        value: track.value,
    }
}

fn grid_layout_in(grid: &t::GridLayout) -> GridLayout {
    GridLayout {
        row_count: grid.row_count,
        column_count: grid.column_count,
        row_gap: grid.row_gap,
        column_gap: grid.column_gap,
        row_sizes: grid.row_sizes.iter().map(track_in).collect(),
        column_sizes: grid.column_sizes.iter().map(track_in).collect(),
        auto_tracks: grid.auto_tracks,
        items_positioning: grid.items_positioning,
    }
}

fn grid_layout_out(grid: &GridLayout) -> t::GridLayout {
    t::GridLayout {
        row_count: grid.row_count,
        column_count: grid.column_count,
        row_gap: grid.row_gap,
        column_gap: grid.column_gap,
        row_sizes: grid.row_sizes.iter().map(track_out).collect(),
        column_sizes: grid.column_sizes.iter().map(track_out).collect(),
        auto_tracks: grid.auto_tracks,
        items_positioning: grid.items_positioning,
    }
}

fn grid_child_in(child: &t::GridChild) -> GridChild {
    GridChild {
        row_anchor_index: child.row_anchor_index,
        column_anchor_index: child.column_anchor_index,
        row_span: child.row_span,
        column_span: child.column_span,
        horizontal_align: child.horizontal_align,
        vertical_align: child.vertical_align,
    }
}

fn grid_child_out(child: &GridChild) -> t::GridChild {
    t::GridChild {
        row_anchor_index: child.row_anchor_index,
        column_anchor_index: child.column_anchor_index,
        row_span: child.row_span,
        column_span: child.column_span,
        horizontal_align: child.horizontal_align,
        vertical_align: child.vertical_align,
    }
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

fn line_height_in(value: &t::LineHeight) -> LineHeight {
    match value {
        t::LineHeight::Auto => LineHeight::Auto,
        t::LineHeight::Pixels(height) => LineHeight::Pixels(height.value),
        t::LineHeight::Percent(height) => LineHeight::Percent(height.value),
    }
}

fn line_height_out(value: &LineHeight) -> t::LineHeight {
    match *value {
        LineHeight::Auto => t::LineHeight::Auto,
        LineHeight::Pixels(value) => t::LineHeight::Pixels(t::LineHeightValue { value }),
        LineHeight::Percent(value) => t::LineHeight::Percent(t::LineHeightValue { value }),
    }
}

fn hyperlink_in(
    link: &Option<Option<t::Hyperlink>>,
    cx: &mut Interning,
) -> Option<Option<Hyperlink>> {
    link.as_ref().map(|link| {
        link.as_ref().map(|link| match link {
            t::Hyperlink::Url(link) => Hyperlink::Url(text(&link.url)),
            t::Hyperlink::Node(link) => Hyperlink::Node(cx.id(&link.node_id)),
        })
    })
}

fn hyperlink_out(link: &Option<Option<Hyperlink>>, cx: &Resolving) -> Option<Option<t::Hyperlink>> {
    link.as_ref().map(|link| {
        link.as_ref().map(|link| match link {
            Hyperlink::Url(url) => t::Hyperlink::Url(t::UrlHyperlink {
                url: url.to_string(),
            }),
            Hyperlink::Node(node) => t::Hyperlink::Node(t::NodeHyperlink {
                node_id: cx.id(*node),
            }),
        })
    })
}

fn text_style_in(style: &t::TextStyle, cx: &mut Interning) -> TextStyle {
    TextStyle {
        font_family: cx.atom(&style.font_family),
        font_weight: style.font_weight,
        italic: style.italic,
        font_size: style.font_size,
        line_height: line_height_in(&style.line_height),
        letter_spacing: style.letter_spacing,
        text_decoration: style.text_decoration,
        text_case: style.text_case,
        hyperlink: hyperlink_in(&style.hyperlink, cx),
    }
}

fn text_style_out(style: &TextStyle, cx: &Resolving) -> t::TextStyle {
    t::TextStyle {
        font_family: cx.atom(style.font_family),
        font_weight: style.font_weight,
        italic: style.italic,
        font_size: style.font_size,
        line_height: line_height_out(&style.line_height),
        letter_spacing: style.letter_spacing,
        text_decoration: style.text_decoration,
        text_case: style.text_case,
        hyperlink: hyperlink_out(&style.hyperlink, cx),
    }
}

pub(super) fn text_props_in(props: &t::TextProps, cx: &mut Interning) -> TextProps {
    TextProps {
        characters: text(&props.characters),
        style: text_style_in(&props.style, cx),
        runs: props
            .runs
            .iter()
            .map(|run| TextRun {
                start: run.start,
                end: run.end,
                style: TextStyleOverride {
                    font_family: run
                        .style
                        .font_family
                        .as_deref()
                        .map(|family| cx.atom(family)),
                    font_weight: run.style.font_weight,
                    italic: run.style.italic,
                    font_size: run.style.font_size,
                    line_height: run.style.line_height.as_ref().map(line_height_in),
                    letter_spacing: run.style.letter_spacing,
                    text_decoration: run.style.text_decoration,
                    text_case: run.style.text_case,
                    hyperlink: hyperlink_in(&run.style.hyperlink, cx),
                },
                fills: run.fills.as_deref().map(|fills| paints_in(fills, cx)),
                text_style_id: run.text_style_id.as_deref().map(|style| cx.atom(style)),
            })
            .collect(),
        text_align_horizontal: props.text_align_horizontal,
        text_align_vertical: props.text_align_vertical,
        text_auto_resize: props.text_auto_resize,
        paragraph_spacing: props.paragraph_spacing,
        paragraph_indent: props.paragraph_indent,
        list_types: props.list_types.clone().map(List::from),
        max_lines: props.max_lines,
    }
}

fn text_props_out(props: &TextProps, cx: &Resolving) -> t::TextProps {
    t::TextProps {
        characters: props.characters.to_string(),
        style: text_style_out(&props.style, cx),
        runs: props
            .runs
            .iter()
            .map(|run| t::TextRun {
                start: run.start,
                end: run.end,
                style: t::TextStyleOverride {
                    font_family: run.style.font_family.map(|family| cx.atom(family)),
                    font_weight: run.style.font_weight,
                    italic: run.style.italic,
                    font_size: run.style.font_size,
                    line_height: run.style.line_height.as_ref().map(line_height_out),
                    letter_spacing: run.style.letter_spacing,
                    text_decoration: run.style.text_decoration,
                    text_case: run.style.text_case,
                    hyperlink: hyperlink_out(&run.style.hyperlink, cx),
                },
                fills: run.fills.as_deref().map(|fills| paints_out(fills, cx)),
                text_style_id: run.text_style_id.map(|style| cx.atom(style)),
            })
            .collect(),
        text_align_horizontal: props.text_align_horizontal,
        text_align_vertical: props.text_align_vertical,
        text_auto_resize: props.text_auto_resize,
        paragraph_spacing: props.paragraph_spacing,
        paragraph_indent: props.paragraph_indent,
        list_types: props.list_types.as_deref().map(<[t::ListType]>::to_vec),
        max_lines: props.max_lines,
    }
}

fn command_in(command: &t::PathCommand) -> PathCommand {
    match *command {
        t::PathCommand::M(point) => PathCommand::M(point),
        t::PathCommand::L(point) => PathCommand::L(point),
        t::PathCommand::C(cubic) => PathCommand::C(cubic),
        t::PathCommand::Q(quad) => PathCommand::Q(quad),
        t::PathCommand::Z => PathCommand::Z,
    }
}

fn command_out(command: &PathCommand) -> t::PathCommand {
    match *command {
        PathCommand::M(point) => t::PathCommand::M(point),
        PathCommand::L(point) => t::PathCommand::L(point),
        PathCommand::C(cubic) => t::PathCommand::C(cubic),
        PathCommand::Q(quad) => t::PathCommand::Q(quad),
        PathCommand::Z => t::PathCommand::Z,
    }
}

fn commands_in(commands: &[t::PathCommand]) -> List<PathCommand> {
    commands.iter().map(command_in).collect()
}

fn commands_out(commands: &[PathCommand]) -> Vec<t::PathCommand> {
    commands.iter().map(command_out).collect()
}

// ── Prototyping ──────────────────────────────────────────────────────────────────────────────────

fn transition_in(transition: &t::Transition) -> Transition {
    let directional = |moving: &t::DirectionalTransition| DirectionalTransition {
        direction: moving.direction,
        match_layers: moving.match_layers,
        duration: moving.duration,
        easing: moving.easing,
    };
    match transition {
        t::Transition::Instant => Transition::Instant,
        t::Transition::Dissolve(timed) => Transition::Dissolve(*timed),
        t::Transition::SmartAnimate(timed) => Transition::SmartAnimate(*timed),
        t::Transition::MoveIn(moving) => Transition::MoveIn(directional(moving)),
        t::Transition::MoveOut(moving) => Transition::MoveOut(directional(moving)),
        t::Transition::Push(moving) => Transition::Push(directional(moving)),
        t::Transition::SlideIn(moving) => Transition::SlideIn(directional(moving)),
        t::Transition::SlideOut(moving) => Transition::SlideOut(directional(moving)),
    }
}

fn transition_out(transition: &Transition) -> t::Transition {
    let directional = |moving: &DirectionalTransition| t::DirectionalTransition {
        direction: moving.direction,
        match_layers: moving.match_layers,
        duration: moving.duration,
        easing: moving.easing,
    };
    match transition {
        Transition::Instant => t::Transition::Instant,
        Transition::Dissolve(timed) => t::Transition::Dissolve(*timed),
        Transition::SmartAnimate(timed) => t::Transition::SmartAnimate(*timed),
        Transition::MoveIn(moving) => t::Transition::MoveIn(directional(moving)),
        Transition::MoveOut(moving) => t::Transition::MoveOut(directional(moving)),
        Transition::Push(moving) => t::Transition::Push(directional(moving)),
        Transition::SlideIn(moving) => t::Transition::SlideIn(directional(moving)),
        Transition::SlideOut(moving) => t::Transition::SlideOut(directional(moving)),
    }
}

fn reaction_in(reaction: &t::Reaction, cx: &mut Interning) -> Reaction {
    Reaction {
        trigger: match &reaction.trigger {
            t::Trigger::OnClick => Trigger::OnClick,
            t::Trigger::OnHover => Trigger::OnHover,
            t::Trigger::OnPress => Trigger::OnPress,
            t::Trigger::OnDrag => Trigger::OnDrag,
            t::Trigger::MouseEnter => Trigger::MouseEnter,
            t::Trigger::MouseLeave => Trigger::MouseLeave,
            t::Trigger::MouseDown => Trigger::MouseDown,
            t::Trigger::MouseUp => Trigger::MouseUp,
            t::Trigger::AfterTimeout(timeout) => Trigger::AfterTimeout(timeout.timeout),
            t::Trigger::OnKeyDown(key) => Trigger::OnKeyDown(text(&key.key_code)),
        },
        actions: reaction
            .actions
            .iter()
            .map(|action| match action {
                t::Action::Node(node) => Action::Node(Box::new(NodeAction {
                    navigation: node.navigation,
                    destination_id: cx.id(&node.destination_id),
                    transition: transition_in(&node.transition),
                    preserve_scroll_position: node.preserve_scroll_position,
                    reset_scroll_position: node.reset_scroll_position,
                    overlay_relative_position: node.overlay_relative_position,
                })),
                t::Action::Back => Action::Back,
                t::Action::Close => Action::Close,
                t::Action::Url(link) => Action::Url {
                    url: text(&link.url),
                    open_in_new_tab: link.open_in_new_tab,
                },
            })
            .collect(),
    }
}

fn reaction_out(reaction: &Reaction, cx: &Resolving) -> t::Reaction {
    t::Reaction {
        trigger: match &reaction.trigger {
            Trigger::OnClick => t::Trigger::OnClick,
            Trigger::OnHover => t::Trigger::OnHover,
            Trigger::OnPress => t::Trigger::OnPress,
            Trigger::OnDrag => t::Trigger::OnDrag,
            Trigger::MouseEnter => t::Trigger::MouseEnter,
            Trigger::MouseLeave => t::Trigger::MouseLeave,
            Trigger::MouseDown => t::Trigger::MouseDown,
            Trigger::MouseUp => t::Trigger::MouseUp,
            Trigger::AfterTimeout(timeout) => {
                t::Trigger::AfterTimeout(t::TimeoutTrigger { timeout: *timeout })
            }
            Trigger::OnKeyDown(key) => t::Trigger::OnKeyDown(t::KeyDownTrigger {
                key_code: key.to_string(),
            }),
        },
        actions: reaction
            .actions
            .iter()
            .map(|action| match action {
                Action::Node(node) => t::Action::Node(t::NodeAction {
                    navigation: node.navigation,
                    destination_id: cx.id(node.destination_id),
                    transition: transition_out(&node.transition),
                    preserve_scroll_position: node.preserve_scroll_position,
                    reset_scroll_position: node.reset_scroll_position,
                    overlay_relative_position: node.overlay_relative_position,
                }),
                Action::Back => t::Action::Back,
                Action::Close => t::Action::Close,
                Action::Url {
                    url,
                    open_in_new_tab,
                } => t::Action::Url(t::UrlAction {
                    url: url.to_string(),
                    open_in_new_tab: *open_in_new_tab,
                }),
            })
            .collect(),
    }
}

fn export_in(setting: &t::ExportSetting) -> ExportSetting {
    ExportSetting {
        format: setting.format,
        suffix: text(&setting.suffix),
        constraint: setting.constraint,
        svg_id_attribute: setting.svg_id_attribute,
    }
}

fn export_out(setting: &ExportSetting) -> t::ExportSetting {
    t::ExportSetting {
        format: setting.format,
        suffix: setting.suffix.to_string(),
        constraint: setting.constraint,
        svg_id_attribute: setting.svg_id_attribute,
    }
}

// ── Annotations, components, board ───────────────────────────────────────────────────────────────

fn annotation_in(annotation: &t::Annotation, cx: &mut Interning) -> Annotation {
    Annotation {
        id: cx.atom(&annotation.id),
        label: text(&annotation.label),
        category_id: annotation
            .category_id
            .as_deref()
            .map(|category| cx.atom(category)),
        properties: annotation
            .properties
            .as_ref()
            .map(|properties| properties.iter().map(|property| property.kind).collect()),
    }
}

fn annotation_out(annotation: &Annotation, cx: &Resolving) -> t::Annotation {
    t::Annotation {
        id: cx.atom(annotation.id),
        label: annotation.label.to_string(),
        category_id: annotation.category_id.map(|category| cx.atom(category)),
        properties: annotation.properties.as_ref().map(|properties| {
            properties
                .iter()
                .map(|&kind| t::AnnotationProperty { kind })
                .collect()
        }),
    }
}

fn measurement_in(measurement: &t::Measurement, cx: &mut Interning) -> Measurement {
    Measurement {
        id: cx.atom(&measurement.id),
        start: MeasurementEnd {
            node_id: cx.id(&measurement.start.node_id),
            side: measurement.start.side,
        },
        end: MeasurementEnd {
            node_id: cx.id(&measurement.end.node_id),
            side: measurement.end.side,
        },
        offset: match measurement.offset {
            t::MeasurementOffset::Inner(inner) => MeasurementOffset::Inner(inner.relative),
            t::MeasurementOffset::Outer(outer) => MeasurementOffset::Outer(outer.fixed),
        },
        free_text: measurement.free_text.as_deref().map(text),
    }
}

fn measurement_out(measurement: &Measurement, cx: &Resolving) -> t::Measurement {
    t::Measurement {
        id: cx.atom(measurement.id),
        start: t::MeasurementEnd {
            node_id: cx.id(measurement.start.node_id),
            side: measurement.start.side,
        },
        end: t::MeasurementEnd {
            node_id: cx.id(measurement.end.node_id),
            side: measurement.end.side,
        },
        offset: match measurement.offset {
            MeasurementOffset::Inner(relative) => {
                t::MeasurementOffset::Inner(t::InnerMeasurementOffset { relative })
            }
            MeasurementOffset::Outer(fixed) => {
                t::MeasurementOffset::Outer(t::OuterMeasurementOffset { fixed })
            }
        },
        free_text: measurement.free_text.as_deref().map(str::to_owned),
    }
}

fn property_value_in(value: &t::PropertyValue, cx: &mut Interning) -> PropertyValue {
    match value {
        t::PropertyValue::Text(value) => PropertyValue::Text(cx.atom(value)),
        t::PropertyValue::Boolean(value) => PropertyValue::Boolean(*value),
    }
}

fn property_value_out(value: &PropertyValue, cx: &Resolving) -> t::PropertyValue {
    match value {
        PropertyValue::Text(value) => t::PropertyValue::Text(cx.atom(*value)),
        PropertyValue::Boolean(value) => t::PropertyValue::Boolean(*value),
    }
}

fn connector_end_in(end: &t::ConnectorEnd, cx: &mut Interning) -> ConnectorEnd {
    match end {
        t::ConnectorEnd::Object(end) => ConnectorEnd::Object {
            node: cx.id(&end.node),
            magnet: end.magnet,
        },
        t::ConnectorEnd::At(end) => ConnectorEnd::ObjectAt {
            node: cx.id(&end.node),
            at: end.at,
        },
        t::ConnectorEnd::Point(point) => ConnectorEnd::Point(*point),
    }
}

fn connector_end_out(end: &ConnectorEnd, cx: &Resolving) -> t::ConnectorEnd {
    match end {
        ConnectorEnd::Object { node, magnet } => t::ConnectorEnd::Object(t::ConnectorObjectEnd {
            node: cx.id(*node),
            magnet: *magnet,
        }),
        ConnectorEnd::ObjectAt { node, at } => t::ConnectorEnd::At(t::ConnectorAtEnd {
            node: cx.id(*node),
            at: *at,
        }),
        ConnectorEnd::Point(point) => t::ConnectorEnd::Point(*point),
    }
}

fn board_in(meta: &t::BoardMeta, cx: &mut Interning) -> BoardMeta {
    match meta {
        t::BoardMeta::Sticky(sticky) => BoardMeta::Sticky { wide: sticky.wide },
        t::BoardMeta::Shape(shape) => BoardMeta::Shape(shape.shape),
        t::BoardMeta::Connector(connector) => {
            let plain = BoardConnector {
                start: connector_end_in(&connector.start, cx),
                end: connector_end_in(&connector.end, cx),
                line: connector.line,
            };
            if connector.label_at.is_none() && connector.points.is_none() {
                BoardMeta::Connector(Box::new(plain))
            } else {
                BoardMeta::ConnectorWith(Box::new(BoardConnectorWith {
                    connector: plain,
                    label_at: connector.label_at,
                    points: connector.points.clone().map(List::from),
                }))
            }
        }
        t::BoardMeta::Stamp(stamp) => BoardMeta::Stamp {
            stamp: stamp.stamp,
            by: stamp.by.as_deref().map(text),
        },
        t::BoardMeta::Sticker(sticker) => BoardMeta::Sticker(cx.atom(&sticker.sticker)),
        t::BoardMeta::Table => BoardMeta::Table,
        t::BoardMeta::Stroke(stroke) => BoardMeta::Stroke(stroke.tool),
        t::BoardMeta::Part(part) if part.col_span.is_none() && part.row_span.is_none() => {
            BoardMeta::Part(part.part)
        }
        t::BoardMeta::Part(part) => BoardMeta::PartSpans {
            part: part.part,
            col_span: part.col_span,
            row_span: part.row_span,
        },
        t::BoardMeta::Section(section) => BoardMeta::Section {
            hidden: section.hidden,
            background_locked: section.background_locked,
        },
    }
}

fn board_out(meta: &BoardMeta, cx: &Resolving) -> t::BoardMeta {
    match meta {
        BoardMeta::Sticky { wide } => t::BoardMeta::Sticky(t::BoardSticky { wide: *wide }),
        BoardMeta::Shape(shape) => t::BoardMeta::Shape(t::BoardShape { shape: *shape }),
        BoardMeta::Connector(connector) => t::BoardMeta::Connector(t::BoardConnector {
            start: connector_end_out(&connector.start, cx),
            end: connector_end_out(&connector.end, cx),
            line: connector.line,
            label_at: None,
            points: None,
        }),
        BoardMeta::ConnectorWith(with) => t::BoardMeta::Connector(t::BoardConnector {
            start: connector_end_out(&with.connector.start, cx),
            end: connector_end_out(&with.connector.end, cx),
            line: with.connector.line,
            label_at: with.label_at,
            points: with
                .points
                .as_ref()
                .map(|points| points.as_slice().to_vec()),
        }),
        BoardMeta::Stamp { stamp, by } => t::BoardMeta::Stamp(t::BoardStamp {
            stamp: *stamp,
            by: by.as_deref().map(str::to_owned),
        }),
        BoardMeta::Sticker(sticker) => t::BoardMeta::Sticker(t::BoardSticker {
            sticker: cx.atom(*sticker),
        }),
        BoardMeta::Table => t::BoardMeta::Table,
        BoardMeta::Stroke(tool) => t::BoardMeta::Stroke(t::BoardStroke { tool: *tool }),
        BoardMeta::Part(part) => t::BoardMeta::Part(t::BoardPartMeta {
            part: *part,
            col_span: None,
            row_span: None,
        }),
        BoardMeta::PartSpans {
            part,
            col_span,
            row_span,
        } => t::BoardMeta::Part(t::BoardPartMeta {
            part: *part,
            col_span: *col_span,
            row_span: *row_span,
        }),
        BoardMeta::Section {
            hidden,
            background_locked,
        } => t::BoardMeta::Section(t::BoardSection {
            hidden: *hidden,
            background_locked: *background_locked,
        }),
    }
}

fn map_in<A, B>(
    map: &t::Map<A>,
    cx: &mut Interning,
    mut value: impl FnMut(&A, &mut Interning) -> B,
) -> IndexMap<Atom, B> {
    let mut out = IndexMap::with_capacity(map.len());
    for (key, item) in map {
        let key = cx.atom(key);
        let item = value(item, cx);
        out.insert(key, item);
    }
    out
}

fn map_out<A, B>(
    map: &IndexMap<Atom, A>,
    cx: &Resolving,
    value: impl Fn(&A, &Resolving) -> B,
) -> t::Map<B> {
    map.iter()
        .map(|(&key, item)| (cx.atom(key), value(item, cx)))
        .collect()
}

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────

pub(super) fn node_in(node: &t::SceneNode, cx: &mut Interning) -> Node {
    let mut props = Vec::new();
    let mut push = |prop: Prop| props.push(prop);
    if let Some(value) = node.mask_type {
        push(Prop::MaskType(value));
    }
    if let Some(value) = node.flip_x {
        push(Prop::FlipX(value));
    }
    if let Some(value) = node.flip_y {
        push(Prop::FlipY(value));
    }
    if let Some(value) = node.constrain_proportions {
        push(Prop::ConstrainProportions(value));
    }
    if !node.dash_pattern.is_empty() {
        push(Prop::DashPattern(node.dash_pattern.clone().into()));
    }
    if let Some(style) = &node.fill_style_id {
        push(Prop::FillStyleId(cx.atom(style)));
    }
    if let Some(style) = &node.stroke_style_id {
        push(Prop::StrokeStyleId(cx.atom(style)));
    }
    if let Some(style) = &node.effect_style_id {
        push(Prop::EffectStyleId(cx.atom(style)));
    }
    if let Some(bound) = &node.bound_variables {
        push(Prop::BoundVariables(Arc::new(map_in(
            bound,
            cx,
            |alias, cx| cx.atom(&alias.id),
        ))));
    }
    if let Some(value) = node.min_width {
        push(Prop::MinWidth(value));
    }
    if let Some(value) = node.max_width {
        push(Prop::MaxWidth(value));
    }
    if let Some(value) = node.min_height {
        push(Prop::MinHeight(value));
    }
    if let Some(value) = node.max_height {
        push(Prop::MaxHeight(value));
    }
    if !node.export_settings.is_empty() {
        push(Prop::ExportSettings(
            node.export_settings.iter().map(export_in).collect(),
        ));
    }
    if !node.reactions.is_empty() {
        push(Prop::Reactions(
            node.reactions
                .iter()
                .map(|reaction| reaction_in(reaction, cx))
                .collect(),
        ));
    }
    if let Some(value) = node.corner_radius {
        push(Prop::CornerRadius(value));
    }
    if let Some(value) = node.rectangle_corner_radii {
        push(Prop::RectangleCornerRadii(value.map(Arc::new)));
    }
    if let Some(value) = node.corner_smoothing {
        push(Prop::CornerSmoothing(value));
    }
    if let Some(value) = node.individual_stroke_weights {
        push(Prop::IndividualStrokeWeights(value.map(Arc::new)));
    }
    if let Some(value) = node.clips_content {
        push(Prop::ClipsContent(value));
    }
    if let Some(value) = &node.auto_layout {
        push(Prop::AutoLayout(Arc::new(value.clone())));
    }
    if let Some(grids) = &node.layout_grids {
        push(Prop::LayoutGrids(grids_in(grids)));
    }
    if let Some(style) = &node.grid_style_id {
        push(Prop::GridStyleId(cx.atom(style)));
    }
    if let Some(value) = node.overflow_direction {
        push(Prop::OverflowDirection(value));
    }
    if let Some(value) = node.overlay_position_type {
        push(Prop::OverlayPositionType(value));
    }
    if let Some(value) = &node.overlay_background {
        push(Prop::OverlayBackground(Arc::new(match value {
            t::OverlayBackground::None => OverlayBackground::None,
            t::OverlayBackground::SolidColor(solid) => OverlayBackground::SolidColor(solid.color),
        })));
    }
    if let Some(value) = node.overlay_background_interaction {
        push(Prop::OverlayBackgroundInteraction(value));
    }
    if let Some(value) = node.scroll_behavior {
        push(Prop::ScrollBehavior(value));
    }
    if let Some(value) = node.background_color {
        push(Prop::BackgroundColor(Arc::new(value)));
    }
    if let Some(guides) = &node.guides {
        push(Prop::Guides(guides.clone().into()));
    }
    if let Some(points) = &node.flow_starting_points {
        push(Prop::FlowStartingPoints(
            points
                .iter()
                .map(|point| FlowStartingPoint {
                    node_id: cx.id(&point.node_id),
                    name: cx.atom(&point.name),
                })
                .collect(),
        ));
    }
    if let Some(device) = &node.prototype_device {
        push(Prop::PrototypeDevice(Arc::new(match device {
            t::PrototypeDevice::None => PrototypeDevice::None,
            t::PrototypeDevice::Preset(preset) => PrototypeDevice::Preset {
                preset_id: text(&preset.preset_id),
                rotation: preset.rotation,
            },
        })));
    }
    if let Some(value) = node.prototype_background {
        push(Prop::PrototypeBackground(Arc::new(value)));
    }
    if let Some(value) = node.arc_data {
        push(Prop::ArcData(Arc::new(value)));
    }
    if let Some(value) = node.point_count {
        push(Prop::PointCount(value));
    }
    if let Some(value) = node.inner_radius {
        push(Prop::InnerRadius(value));
    }
    if let Some(value) = node.stroke_start_marker {
        push(Prop::StrokeStartMarker(value));
    }
    if let Some(value) = node.stroke_end_marker {
        push(Prop::StrokeEndMarker(value));
    }
    if let Some(stroke) = &node.variable_width_stroke_properties {
        push(Prop::VariableWidthStrokeProperties(Arc::new(
            VariableWidthStroke {
                width_profile: stroke.width_profile,
                variable_width_points: stroke.variable_width_points.clone().map(List::from),
            },
        )));
    }
    if let Some(paths) = &node.vector_paths {
        push(Prop::VectorPaths(
            paths
                .iter()
                .map(|path| VectorPath {
                    winding_rule: path.winding_rule,
                    commands: commands_in(&path.commands),
                })
                .collect(),
        ));
    }
    if let Some(value) = node.boolean_operation {
        push(Prop::BooleanOperation(value));
    }
    if let Some(props) = &node.text {
        push(Prop::Text(Arc::new(text_props_in(props, cx))));
    }
    if let Some(style) = &node.text_style_id {
        push(Prop::TextStyleId(cx.atom(style)));
    }
    if let Some(path) = &node.text_path {
        push(Prop::TextPath(Arc::new(TextPath {
            commands: commands_in(&path.commands),
            start_offset: path.start_offset,
            side: path.side,
        })));
    }
    if let Some(annotations) = &node.annotations {
        push(Prop::Annotations(
            annotations
                .iter()
                .map(|annotation| annotation_in(annotation, cx))
                .collect(),
        ));
    }
    if let Some(measurements) = &node.measurements {
        push(Prop::Measurements(
            measurements
                .iter()
                .map(|measurement| measurement_in(measurement, cx))
                .collect(),
        ));
    }
    if let Some(description) = &node.description {
        push(Prop::Description(text(description)));
    }
    if let Some(definitions) = &node.component_property_definitions {
        push(Prop::ComponentPropertyDefinitions(Arc::new(map_in(
            definitions,
            cx,
            |definition, cx| PropertyDefinition {
                kind: definition.kind,
                default_value: property_value_in(&definition.default_value, cx),
                variant_options: definition
                    .variant_options
                    .as_deref()
                    .map(|options| cx.atoms(options)),
                preferred_values: definition
                    .preferred_values
                    .as_deref()
                    .map(|values| cx.ids(values)),
            },
        ))));
    }
    if let Some(references) = &node.component_property_references {
        push(Prop::ComponentPropertyReferences(Arc::new(
            PropertyReferences {
                visible: references.visible.as_deref().map(|value| cx.atom(value)),
                characters: references.characters.as_deref().map(|value| cx.atom(value)),
                main_component: references
                    .main_component
                    .as_deref()
                    .map(|value| cx.atom(value)),
            },
        )));
    }
    if let Some(component) = &node.component_id {
        push(Prop::ComponentId(cx.id(component)));
    }
    if let Some(properties) = &node.component_properties {
        push(Prop::ComponentProperties(Arc::new(map_in(
            properties,
            cx,
            property_value_in,
        ))));
    }
    if let Some(value) = node.is_exposed_instance {
        push(Prop::IsExposedInstance(value));
    }
    if let Some(main) = &node.main_id {
        push(Prop::MainId(cx.id(main)));
    }
    if let Some(overrides) = &node.overrides {
        push(Prop::Overrides(cx.atoms(overrides)));
    }
    if let Some(data) = &node.plugin_data {
        push(Prop::PluginData(Arc::new(map_in(data, cx, |value, _| {
            text(value)
        }))));
    }
    if let Some(remote) = &node.remote {
        push(Prop::Remote(Arc::new(remote.clone())));
    }
    if let Some(meta) = &node.board {
        push(Prop::Board(Arc::new(board_in(meta, cx))));
    }
    if let Some(grid) = &node.grid {
        push(Prop::Grid(Arc::new(grid_layout_in(grid))));
    }
    if let Some(child) = &node.grid_child {
        push(Prop::GridChild(Arc::new(grid_child_in(child))));
    }
    Node {
        id: cx.id(&node.id),
        parent: node.parent_id.as_deref().map(|parent| cx.id(parent)),
        name: cx.atom(&node.name),
        kind: node.kind,
        blend_mode: node.blend_mode,
        stroke_align: node.stroke_align,
        stroke_cap: node.stroke_cap,
        stroke_join: node.stroke_join,
        layout_positioning: node.layout_positioning,
        layout_sizing_horizontal: node.layout_sizing_horizontal,
        layout_sizing_vertical: node.layout_sizing_vertical,
        constraints: node.constraints,
        visible: node.visible,
        locked: node.locked,
        is_mask: node.is_mask,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        opacity: node.opacity,
        stroke_weight: node.stroke_weight,
        stroke_miter_limit: node.stroke_miter_limit,
        children: node
            .children
            .as_ref()
            .map(|children| children.iter().map(|child| cx.id(child)).collect()),
        fills: paints_in(&node.fills, cx),
        strokes: paints_in(&node.strokes, cx),
        effects: effects_in(&node.effects),
        props: Props::new(props),
    }
}

pub(super) fn node_out(node: &Node, cx: &Resolving) -> t::SceneNode {
    let props = &node.props;
    t::SceneNode {
        id: cx.id(node.id),
        kind: node.kind,
        name: cx.atom(node.name),
        parent_id: node.parent.map(|parent| cx.id(parent)),
        children: node.children.as_deref().map(|children| cx.ids(children)),
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        blend_mode: node.blend_mode,
        is_mask: node.is_mask,
        mask_type: props.mask_type().copied(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        flip_x: props.flip_x().copied(),
        flip_y: props.flip_y().copied(),
        constrain_proportions: props.constrain_proportions().copied(),
        fills: paints_out(&node.fills, cx),
        strokes: paints_out(&node.strokes, cx),
        stroke_weight: node.stroke_weight,
        stroke_align: node.stroke_align,
        stroke_cap: node.stroke_cap,
        stroke_join: node.stroke_join,
        stroke_miter_limit: node.stroke_miter_limit,
        dash_pattern: props
            .dash_pattern()
            .map(|dashes| dashes.to_vec())
            .unwrap_or_default(),
        effects: effects_out(&node.effects),
        fill_style_id: props.fill_style_id().map(|&style| cx.atom(style)),
        stroke_style_id: props.stroke_style_id().map(|&style| cx.atom(style)),
        effect_style_id: props.effect_style_id().map(|&style| cx.atom(style)),
        bound_variables: props
            .bound_variables()
            .map(|bound| map_out(bound, cx, |&variable, cx| alias(cx, variable))),
        constraints: node.constraints,
        layout_positioning: node.layout_positioning,
        layout_sizing_horizontal: node.layout_sizing_horizontal,
        layout_sizing_vertical: node.layout_sizing_vertical,
        min_width: props.min_width().copied(),
        max_width: props.max_width().copied(),
        min_height: props.min_height().copied(),
        max_height: props.max_height().copied(),
        export_settings: props
            .export_settings()
            .map(|settings| settings.iter().map(export_out).collect())
            .unwrap_or_default(),
        reactions: props
            .reactions()
            .map(|reactions| {
                reactions
                    .iter()
                    .map(|reaction| reaction_out(reaction, cx))
                    .collect()
            })
            .unwrap_or_default(),
        corner_radius: props.corner_radius().copied(),
        rectangle_corner_radii: props
            .rectangle_corner_radii()
            .map(|radii| radii.as_deref().copied()),
        corner_smoothing: props.corner_smoothing().copied(),
        individual_stroke_weights: props
            .individual_stroke_weights()
            .map(|weights| weights.as_deref().copied()),
        clips_content: props.clips_content().copied(),
        auto_layout: props.auto_layout().map(|layout| (**layout).clone()),
        layout_grids: props.layout_grids().map(|grids| grids_out(grids)),
        grid_style_id: props.grid_style_id().map(|&style| cx.atom(style)),
        overflow_direction: props.overflow_direction().copied(),
        overlay_position_type: props.overlay_position_type().copied(),
        overlay_background: props
            .overlay_background()
            .map(|background| match **background {
                OverlayBackground::None => t::OverlayBackground::None,
                OverlayBackground::SolidColor(color) => {
                    t::OverlayBackground::SolidColor(t::OverlayColor { color })
                }
            }),
        overlay_background_interaction: props.overlay_background_interaction().copied(),
        scroll_behavior: props.scroll_behavior().copied(),
        background_color: props.background_color().map(|color| **color),
        guides: props.guides().map(|guides| guides.to_vec()),
        flow_starting_points: props.flow_starting_points().map(|points| {
            points
                .iter()
                .map(|point| t::FlowStartingPoint {
                    node_id: cx.id(point.node_id),
                    name: cx.atom(point.name),
                })
                .collect()
        }),
        prototype_device: props.prototype_device().map(|device| match &**device {
            PrototypeDevice::None => t::PrototypeDevice::None,
            PrototypeDevice::Preset {
                preset_id,
                rotation,
            } => t::PrototypeDevice::Preset(t::PresetDevice {
                preset_id: preset_id.to_string(),
                rotation: *rotation,
            }),
        }),
        prototype_background: props.prototype_background().map(|color| **color),
        arc_data: props.arc_data().map(|arc| **arc),
        point_count: props.point_count().copied(),
        inner_radius: props.inner_radius().copied(),
        stroke_start_marker: props.stroke_start_marker().copied(),
        stroke_end_marker: props.stroke_end_marker().copied(),
        variable_width_stroke_properties: props.variable_width_stroke_properties().map(|stroke| {
            t::VariableWidthStrokeProperties {
                width_profile: stroke.width_profile,
                variable_width_points: stroke
                    .variable_width_points
                    .as_deref()
                    .map(<[t::VariableWidthPoint]>::to_vec),
            }
        }),
        vector_paths: props.vector_paths().map(|paths| {
            paths
                .iter()
                .map(|path| t::VectorPath {
                    winding_rule: path.winding_rule,
                    commands: commands_out(&path.commands),
                })
                .collect()
        }),
        boolean_operation: props.boolean_operation().copied(),
        text: props.text().map(|text| text_props_out(text, cx)),
        text_style_id: props.text_style_id().map(|&style| cx.atom(style)),
        text_path: props.text_path().map(|path| t::TextPathData {
            commands: commands_out(&path.commands),
            start_offset: path.start_offset,
            side: path.side,
        }),
        annotations: props.annotations().map(|annotations| {
            annotations
                .iter()
                .map(|annotation| annotation_out(annotation, cx))
                .collect()
        }),
        measurements: props.measurements().map(|measurements| {
            measurements
                .iter()
                .map(|measurement| measurement_out(measurement, cx))
                .collect()
        }),
        description: props
            .description()
            .map(|description| description.to_string()),
        component_property_definitions: props.component_property_definitions().map(|definitions| {
            map_out(definitions, cx, |definition, cx| {
                t::ComponentPropertyDefinition {
                    kind: definition.kind,
                    default_value: property_value_out(&definition.default_value, cx),
                    variant_options: definition
                        .variant_options
                        .as_deref()
                        .map(|options| cx.atoms(options)),
                    preferred_values: definition
                        .preferred_values
                        .as_deref()
                        .map(|values| cx.ids(values)),
                }
            })
        }),
        component_property_references: props.component_property_references().map(|references| {
            t::ComponentPropertyReferences {
                visible: references.visible.map(|value| cx.atom(value)),
                characters: references.characters.map(|value| cx.atom(value)),
                main_component: references.main_component.map(|value| cx.atom(value)),
            }
        }),
        component_id: props.component_id().map(|&component| cx.id(component)),
        component_properties: props
            .component_properties()
            .map(|properties| map_out(properties, cx, property_value_out)),
        is_exposed_instance: props.is_exposed_instance().copied(),
        main_id: props.main_id().map(|&main| cx.id(main)),
        overrides: props.overrides().map(|overrides| cx.atoms(overrides)),
        plugin_data: props
            .plugin_data()
            .map(|data| map_out(data, cx, |value, _| value.to_string())),
        remote: props.remote().map(|remote| (**remote).clone()),
        board: props.board().map(|meta| board_out(meta, cx)),
        grid: props.grid().map(|grid| grid_layout_out(grid)),
        grid_child: props.grid_child().map(|child| grid_child_out(child)),
    }
}

// ── Styles, variables, images, the document ──────────────────────────────────────────────────────

fn style_in(style: &t::Style, cx: &mut Interning) -> Style {
    Style {
        id: cx.atom(&style.id),
        kind: style.kind,
        name: cx.atom(&style.name),
        description: text(&style.description),
        paints: style.paints.as_deref().map(|paints| paints_in(paints, cx)),
        text: style.text.as_ref().map(|style| text_style_in(style, cx)),
        effects: style.effects.as_deref().map(effects_in),
        grids: style.grids.as_deref().map(grids_in),
        remote: style.remote.clone(),
    }
}

fn style_out(style: &Style, cx: &Resolving) -> t::Style {
    t::Style {
        id: cx.atom(style.id),
        kind: style.kind,
        name: cx.atom(style.name),
        description: style.description.to_string(),
        paints: style.paints.as_deref().map(|paints| paints_out(paints, cx)),
        text: style.text.as_ref().map(|style| text_style_out(style, cx)),
        effects: style.effects.as_deref().map(effects_out),
        grids: style.grids.as_deref().map(grids_out),
        remote: style.remote.clone(),
    }
}

fn image_in(image: &t::ImageAsset) -> ImageAsset {
    ImageAsset {
        url: text(&image.url),
        width: image.width,
        height: image.height,
        name: image.name.as_deref().map(text),
    }
}

fn image_out(image: &ImageAsset) -> t::ImageAsset {
    t::ImageAsset {
        url: image.url.to_string(),
        width: image.width,
        height: image.height,
        name: image.name.as_deref().map(str::to_owned),
    }
}

fn collection_in(collection: &t::VariableCollection, cx: &mut Interning) -> VariableCollection {
    VariableCollection {
        id: cx.atom(&collection.id),
        name: cx.atom(&collection.name),
        modes: collection
            .modes
            .iter()
            .map(|mode| VariableMode {
                mode_id: cx.atom(&mode.mode_id),
                name: cx.atom(&mode.name),
            })
            .collect(),
        default_mode_id: cx.atom(&collection.default_mode_id),
        variable_ids: cx.atoms(&collection.variable_ids),
        remote: collection.remote.clone(),
    }
}

fn collection_out(collection: &VariableCollection, cx: &Resolving) -> t::VariableCollection {
    t::VariableCollection {
        id: cx.atom(collection.id),
        name: cx.atom(collection.name),
        modes: collection
            .modes
            .iter()
            .map(|mode| t::VariableMode {
                mode_id: cx.atom(mode.mode_id),
                name: cx.atom(mode.name),
            })
            .collect(),
        default_mode_id: cx.atom(collection.default_mode_id),
        variable_ids: cx.atoms(&collection.variable_ids),
        remote: collection.remote.clone(),
    }
}

fn variable_in(variable: &t::Variable, cx: &mut Interning) -> Variable {
    Variable {
        id: cx.atom(&variable.id),
        name: cx.atom(&variable.name),
        collection_id: cx.atom(&variable.collection_id),
        kind: variable.kind,
        values_by_mode: map_in(&variable.values_by_mode, cx, |value, cx| match value {
            t::VariableValue::Color(color) => VariableValue::Color(*color),
            t::VariableValue::Number(number) => VariableValue::Number(*number),
            t::VariableValue::Text(value) => VariableValue::Text(text(value)),
            t::VariableValue::Boolean(flag) => VariableValue::Boolean(*flag),
            t::VariableValue::Alias(alias) => VariableValue::Alias(cx.atom(&alias.id)),
        }),
        description: text(&variable.description),
        hidden_from_publishing: variable.hidden_from_publishing,
        remote: variable.remote.clone(),
    }
}

fn variable_out(variable: &Variable, cx: &Resolving) -> t::Variable {
    t::Variable {
        id: cx.atom(variable.id),
        name: cx.atom(variable.name),
        collection_id: cx.atom(variable.collection_id),
        kind: variable.kind,
        values_by_mode: map_out(&variable.values_by_mode, cx, |value, cx| match value {
            VariableValue::Color(color) => t::VariableValue::Color(*color),
            VariableValue::Number(number) => t::VariableValue::Number(*number),
            VariableValue::Text(value) => t::VariableValue::Text(value.to_string()),
            VariableValue::Boolean(flag) => t::VariableValue::Boolean(*flag),
            VariableValue::Alias(variable) => t::VariableValue::Alias(alias(cx, *variable)),
        }),
        description: variable.description.to_string(),
        hidden_from_publishing: variable.hidden_from_publishing,
        remote: variable.remote.clone(),
    }
}

fn modes_in(modes: &t::Map<String>, cx: &mut Interning) -> IndexMap<Atom, Atom> {
    map_in(modes, cx, |mode, cx| cx.atom(mode))
}

fn modes_out(modes: &IndexMap<Atom, Atom>, cx: &Resolving) -> t::Map<String> {
    map_out(modes, cx, |&mode, cx| cx.atom(mode))
}

impl Document {
    /// Converts a JSON-model document. Node slots follow the file's key order. Expects every node keyed by its own
    /// `id`, as `validateDocument` guarantees (a node is stored under its `id`).
    pub fn from_model(doc: &t::DesignDocument) -> Document {
        let mut ids = Interner::new();
        let key_bytes: usize = doc.nodes.keys().map(String::len).sum();
        ids.reserve(doc.nodes.len(), key_bytes);
        for key in doc.nodes.keys() {
            ids.intern(key);
        }
        let mut ids = Arc::new(ids);
        let mut atoms = Arc::new(Interner::new());
        let mut shared = Shared {
            ids: &mut ids,
            atoms: &mut atoms,
        };
        let mut cx = Interning::new(&mut shared);
        let mut nodes: Vec<Option<Arc<Node>>> = vec![None; doc.nodes.len()];
        let mut count = 0;
        for node in doc.nodes.values() {
            let node = node_in(node, &mut cx);
            let index = node.id.index();
            if index >= nodes.len() {
                nodes.resize(index + 1, None);
            }
            if nodes[index].replace(Arc::new(node)).is_none() {
                count += 1;
            }
        }
        let pages = doc.pages.iter().map(|page| cx.id(page)).collect();
        let styles = map_in(&doc.styles, &mut cx, style_in);
        let images = map_in(&doc.images, &mut cx, |image, _| image_in(image));
        let variable_collections = map_in(&doc.variable_collections, &mut cx, collection_in);
        let variables = map_in(&doc.variables, &mut cx, variable_in);
        let variable_modes = doc.variable_modes.as_ref().map(|modes| {
            let mut out = IndexMap::with_capacity(modes.len());
            for (node, choice) in modes {
                let node = cx.id(node);
                let choice = modes_in(choice, &mut cx);
                out.insert(node, choice);
            }
            Arc::new(out)
        });
        let _ = cx;
        Document {
            ids,
            atoms,
            nodes,
            count,
            schema_version: doc.schema_version,
            pages,
            styles: Arc::new(styles),
            images: Arc::new(images),
            variable_collections: Arc::new(variable_collections),
            variables: Arc::new(variables),
            variable_modes,
            board: doc.board,
        }
    }
}

pub(super) fn document_out(doc: &Document, cx: &Resolving) -> t::DesignDocument {
    t::DesignDocument {
        nodes: doc
            .nodes()
            .map(|node| (cx.id(node.id), node_out(node, cx)))
            .collect(),
        ..tables_out(doc, cx)
    }
}

/// [`document_out`] without the node table (`nodes` empty): the tables a draft over the store reads as they are.
pub(super) fn tables_out(doc: &Document, cx: &Resolving) -> t::DesignDocument {
    t::DesignDocument {
        schema_version: doc.schema_version,
        pages: cx.ids(&doc.pages),
        nodes: t::Map::default(),
        styles: map_out(&doc.styles, cx, style_out),
        images: map_out(&doc.images, cx, |image, _| image_out(image)),
        variable_collections: map_out(&doc.variable_collections, cx, collection_out),
        variables: map_out(&doc.variables, cx, variable_out),
        variable_modes: doc.variable_modes.as_ref().map(|modes| {
            modes
                .iter()
                .map(|(&node, choice)| (cx.id(node), modes_out(choice, cx)))
                .collect()
        }),
        board: doc.board,
    }
}

/// A patch as a journal entry of `doc`: its strings interned into the document (the new ones recorded), its values
/// converted. Removals of keys the document never had are dropped, except in `variableModes`, where any entry creates
/// the table (`applyPatch`).
pub(super) fn entry_in(doc: &mut Document, patch: &DocumentPatch) -> Entry {
    let ids_before = doc.ids.len();
    let atoms_before = doc.atoms.len();
    let mut shared = Shared {
        ids: &mut doc.ids,
        atoms: &mut doc.atoms,
    };
    let mut entry = entry_from_patch(&mut shared, patch);
    entry.ids_before = ids_before as u32;
    entry.atoms_before = atoms_before as u32;
    // By index: `Interner::iter().skip(n)` would still resolve the n strings it skips (O(document) per commit).
    entry.new_ids = (ids_before..doc.ids.len())
        .map(|index| doc.ids.resolve(Id::from_index(index)).into())
        .collect();
    entry.new_atoms = (atoms_before..doc.atoms.len())
        .map(|index| doc.atoms.resolve(Atom::from_index(index)).into())
        .collect();
    entry
}

/// The writes of a patch in the symbols of `symbols` (interning the new strings there): an [`Entry`] without its
/// interner bookkeeping (`ids_before`, `new_ids` and the atoms' twins are the caller's, who knows the interners).
pub(super) fn entry_from_patch(symbols: &mut dyn Symbols, patch: &DocumentPatch) -> Entry {
    let mut entry = Entry::default();
    let mut cx = Interning::new(symbols);
    if let Some(changes) = &patch.nodes {
        for (key, change) in changes {
            match change {
                Some(node) => {
                    let node = node_in(node, &mut cx);
                    entry.nodes.push((node.id, Some(Arc::new(node))));
                }
                None => {
                    if let Some(id) = cx.symbols.get_id(key) {
                        entry.nodes.push((id, None));
                    }
                }
            }
        }
    }
    entry.pages = patch
        .pages
        .as_ref()
        .map(|pages| pages.iter().map(|page| cx.id(page)).collect());
    fn table<A, B>(
        changes: &Option<t::Map<Option<A>>>,
        cx: &mut Interning,
        convert: impl Fn(&A, &mut Interning) -> B,
    ) -> Vec<(Atom, Option<B>)> {
        let mut out = Vec::new();
        for (key, change) in changes.iter().flatten() {
            match change {
                Some(value) => {
                    let key = cx.atom(key);
                    out.push((key, Some(convert(value, cx))));
                }
                None => {
                    if let Some(key) = cx.symbols.get_atom(key) {
                        out.push((key, None));
                    }
                }
            }
        }
        out
    }
    entry.styles = table(&patch.styles, &mut cx, style_in);
    entry.images = table(&patch.images, &mut cx, |image, _| image_in(image));
    entry.variable_collections = table(&patch.variable_collections, &mut cx, collection_in);
    entry.variables = table(&patch.variables, &mut cx, variable_in);
    for (key, change) in patch.variable_modes.iter().flatten() {
        let node = cx.id(key);
        let choice = change.as_ref().map(|choice| modes_in(choice, &mut cx));
        entry.variable_modes.push((node, choice));
    }
    entry
}
