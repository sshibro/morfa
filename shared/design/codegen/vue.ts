import type {Attr, El} from './tree';
import type {SvgNode} from './svg';

// Design → Vue (docs/design-tool.md §Design to code): the template syntax of the Vue 3 single-file components the React
// generator (react.ts) also writes. The element tree, classes, variant logic and stylesheets are the React export's; this
// file only spells them as a Vue template: `:prop="expression"`, `v-if`, `v-for`, `{{ text }}`, slots for a button's label
// and an instance swap, `<template>` for a fragment.

/** Names a Vue template or an SFC's script reads at the top of a file, and the built-in components a tag cannot be. */
export const VUE_RESERVED = ['Component', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Slot', 'Template', 'ComponentsPage',
  'computed', 'useAttrs', 'attrs', 'inputAttrs', 'defineProps', 'withDefaults', 'defineOptions', 'ref'];

/** A JS string literal in single quotes: quotes, backslashes and line breaks escaped. */
export const jsString = (text: string) =>
  `'${text.replace(/[\\'\n\r\u2028\u2029]/g, char => (char === '\\' ? '\\\\' : char === "'" ? "\\'" : char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\u2028' ? '\\u2028' : '\\u2029'))}'`;

/** A value inside a double-quoted HTML attribute. */
export const attrValue = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Text as template content: markup and mustaches escaped; edge spaces of a text on its own line kept as an interpolation
 *  (the template condenses them). */
export function vueText(text: string, ownLine = false): string {
  // Inside the interpolation, braces and `<` are escapes: a `}}` or a tag in the text cannot end it.
  if (/\{\{|\}\}/.test(text) || (ownLine && /^\s|\s$/.test(text))) return `{{ ${jsString(text).replace(/[{}<]/g, char => `\\x${char.charCodeAt(0).toString(16)}`)} }}`;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Reads one string literal starting at `start` (a quote); returns its value and the index after it. */
function readString(source: string, start: number): {value: string; end: number} {
  const quote = source[start];
  let i = start + 1;
  let raw = '';
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') {
      raw += source.slice(i, i + 2);
      i += 2;
    } else raw += source[i++];
  }
  const json = quote === '"' ? raw : raw.replace(/\\'/g, "'").replace(/"/g, '\\"');
  let value: string;
  try {
    value = JSON.parse(`"${json}"`) as string;
  } catch {
    value = raw;
  }
  return {value, end: i + 1};
}

/** A JS expression for a template: string literals in single quotes (so it sits in a double-quoted attribute; a double quote
 *  inside one becomes `&quot;`, which the template decodes), and identifiers `rename` maps (a slot's name → `$slots.icon`).
 *  Members (`item.title`) and object keys are left alone. */
export function vueExpr(expr: string, options: {attr?: boolean; rename?: (name: string) => string | undefined} = {}): string {
  let out = '';
  for (let i = 0; i < expr.length;) {
    const char = expr[i];
    if (char === '"' || char === "'") {
      const {value, end} = readString(expr, i);
      const literal = jsString(value);
      out += options.attr ? literal.replace(/"/g, '&quot;') : literal;
      i = end;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
    if (ident) {
      const name = ident[0];
      const member = /\.\s*$/.test(out) && !/\.\.\.\s*$/.test(out);
      const key = /^\s*:/.test(expr.slice(i + name.length)) && /[{,]\s*$/.test(out);
      out += !member && !key && options.rename ? options.rename(name) ?? name : name;
      i += name.length;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** Identifiers an expression reads (outside its string literals and members). */
export function exprIdents(expr: string): Set<string> {
  const out = new Set<string>();
  vueExpr(expr, {rename: name => (out.add(name), undefined)});
  return out;
}

/** React's attribute names on HTML elements as HTML writes them. */
const HTML_ATTRS: Record<string, string> = {htmlFor: 'for', tabIndex: 'tabindex', readOnly: 'readonly', maxLength: 'maxlength', minLength: 'minlength', autoComplete: 'autocomplete', inputMode: 'inputmode', className: 'class'};

/** One attribute, with a leading space: `name="text"`, `:name="expression"`, or a bare `name` for true. */
export function vueAttr(attr: Attr, options: {html?: boolean; rename?: (name: string) => string | undefined} = {}): string {
  const name = options.html ? HTML_ATTRS[attr.name] ?? attr.name : attr.name;
  if (!attr.expr) return ` ${name}="${attrValue(attr.value)}"`;
  if (attr.value === '') return ` ${name}`;
  return ` :${name}="${vueExpr(attr.value, {attr: true, rename: options.rename})}"`;
}

/** A prop whose value is markup (an instance swap: `<StarIcon />`), which a Vue usage passes as a slot. */
export const isSlotValue = (attr: Attr) => attr.expr && (attr.value.startsWith('<') || attr.value === 'null');

/** A one-element JSX usage as the generator writes it (`<Badge size="small" active n={40} />`) in template syntax. */
export function jsxUsageToVue(jsx: string): string {
  return jsx.replace(/ ([A-Za-z_$][\w$-]*)=\{([^{}]*)\}/g, (_, name: string, value: string) => ` :${name}="${vueExpr(value, {attr: true})}"`);
}

/** The slots a usage passes: `<template #icon><StarIcon /></template>`. A hidden swap (null) passes nothing. */
export function slotTemplates(attrs: readonly Attr[]): string[] {
  return attrs.filter(attr => isSlotValue(attr) && attr.value !== 'null').map(attr => `<template #${attr.name}>${jsxUsageToVue(attr.value)}</template>`);
}

/** `<Badge label="New" />`: a component as used, in template syntax (the project's component page, the "Code" tab). */
export function vueUsageSnippet(el: El, hidden: (component: string, slot: string) => string | undefined = () => undefined): string {
  const props = el.props.flatMap(attr => {
    if (!isSlotValue(attr)) return [vueAttr(attr)];
    const toggle = attr.value === 'null' ? hidden(el.tag, attr.name) : undefined;
    return toggle ? [` :${toggle}="false"`] : [];
  }).join('');
  const children = [
    ...slotTemplates(el.props),
    ...el.children.map(child => (child.kind === 'el' ? '' : child.kind === 'br' ? '<br />' : child.kind === 'expr' ? `{{ ${vueExpr(child.expr)} }}` : vueText(child.text))),
  ].join('');
  return children ? `<${el.tag}${props}>${children}</${el.tag}>` : `<${el.tag}${props} />`;
}

/** The picture's children as template lines at `indent`, inside an `<svg fill="none">` (as svgChildrenJsx: an inherited
 *  `fill="none"` is left out). SVG keeps its own attribute names in a template. */
export function svgChildrenVue(root: SvgNode, indent: string): string[] {
  const lines: string[] = [];
  const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\{\{/g, '{&#123;');
  const write = (node: SvgNode, pad: string, fill: string) => {
    const own = node.attrs.find(([key]) => key === 'fill')?.[1];
    const attrs = node.attrs.filter(([key, value]) => !(key === 'fill' && value === 'none' && fill === 'none')).map(([key, value]) => `${key}="${attrValue(value)}"`).join(' ');
    const open = `<${node.tag}${attrs ? ' ' + attrs : ''}`;
    if (!node.children.length) {
      lines.push(`${pad}${open} />`);
      return;
    }
    if (node.children.every(child => typeof child === 'string')) {
      lines.push(`${pad}${open}>${node.children.map(child => text(child as string)).join('')}</${node.tag}>`);
      return;
    }
    lines.push(`${pad}${open}>`);
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim()) lines.push(`${pad}  ${text(child)}`);
      } else write(child, pad + '  ', own ?? fill);
    }
    lines.push(`${pad}</${node.tag}>`);
  };
  for (const child of root.children) if (typeof child !== 'string') write(child, indent, 'none');
  return lines;
}

/** Designer's words inside an HTML comment: one line, and never the comment's end. */
export const commentText = (text: string) => text.replace(/\s+/g, ' ').replace(/--/g, '- -');

/** A single-file component from its parts; empty parts are left out. */
export function sfc(parts: {comment: string[]; script: string[]; setup: string[]; template: string[]; style: string}): string {
  const blocks: string[] = [];
  const head = parts.comment.map(line => `<!-- ${commentText(line)} -->`).join('\n');
  if (parts.script.length) blocks.push(['<script lang="ts">', ...parts.script, '</script>'].join('\n'));
  if (parts.setup.length) blocks.push(['<script setup lang="ts">', ...parts.setup, '</script>'].join('\n'));
  blocks.push(['<template>', ...parts.template, '</template>'].join('\n'));
  if (parts.style) blocks.push(`<style module>\n${parts.style}</style>`);
  return (head ? head + '\n' : '') + blocks.join('\n\n') + '\n';
}
