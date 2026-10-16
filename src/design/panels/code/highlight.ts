// A small syntax highlighter for the "Code" tab: TSX/TS, CSS, JSON, HTML, Vue and Markdown, line by line
// with the state that crosses lines (block comments, template strings, JSX tags). It colours, it
// does not parse: wrong guesses only change a colour. No dependency, so the editor chunk stays lean.

export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'tag' | 'attr' | 'type' | 'prop' | 'value' | 'punct' | 'func' | 'selector' | 'heading';
export type Token = {kind: TokenKind; text: string};
export type CodeLanguage = 'tsx' | 'ts' | 'css' | 'json' | 'html' | 'vue' | 'md' | 'text';

const KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'function', 'return', 'const', 'let', 'var', 'type', 'interface', 'as', 'satisfies', 'if', 'else',
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'keyof', 'in', 'of', 'for', 'while', 'async', 'await', 'extends', 'this',
]);

export function languageOf(path: string): CodeLanguage {
  if (/\.tsx$/.test(path)) return 'tsx';
  if (/\.ts$/.test(path)) return 'ts';
  if (/\.css$/.test(path)) return 'css';
  if (/\.json$/.test(path)) return 'json';
  if (/\.html$/.test(path)) return 'html';
  if (/\.vue$/.test(path)) return 'vue';
  if (/\.md$/.test(path)) return 'md';
  return 'text';
}

type State = {comment: boolean; template: boolean; tag: boolean; block?: 'script' | 'style' | null};

/** Tokens per line. The texts of a line's tokens join back to the line exactly. */
export function highlight(code: string, language: CodeLanguage): Token[][] {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (code.endsWith('\n')) lines.pop();
  const state: State = {comment: false, template: false, tag: false};
  const scan: (line: string, state: State) => Token[] = language === 'css' ? cssLine : language === 'json' ? jsonLine : language === 'html' ? htmlLine : language === 'vue' ? vueLine : language === 'text' ? plainLine : scriptLine;
  const fence = {open: false};
  return lines.map(line => (language === 'md' ? mdLine(line, fence) : scan(line, state)));
}

function push(out: Token[], kind: TokenKind, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({kind, text});
}

const plainLine = (line: string): Token[] => (line ? [{kind: 'plain', text: line}] : []);

/** The end of a quoted string starting at `start` (after the closing quote, or the line's end). */
function stringEnd(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === '\\') i += 2;
    else if (line[i] === quote) return i + 1;
    else i++;
  }
  return line.length;
}

function scriptLine(line: string, state: State): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (state.comment) {
      const end = line.indexOf('*/', i);
      if (end < 0) { push(out, 'comment', line.slice(i)); return out; }
      push(out, 'comment', line.slice(i, end + 2));
      i = end + 2;
      state.comment = false;
      continue;
    }
    if (state.template) {
      let j = i;
      while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) { push(out, 'string', line.slice(i)); return out; }
      push(out, 'string', line.slice(i, j + 1));
      i = j + 1;
      state.template = false;
      continue;
    }
    const rest = line.slice(i);
    const c = line[i];
    if (rest.startsWith('//')) { push(out, 'comment', rest); break; }
    if (rest.startsWith('{/*')) {
      const end = line.indexOf('*/}', i);
      const stop = end < 0 ? line.length : end + 3;
      push(out, 'comment', line.slice(i, stop));
      i = stop;
      continue;
    }
    if (rest.startsWith('/*')) { state.comment = true; push(out, 'comment', '/*'); i += 2; continue; }
    if (c === '"' || c === "'") {
      const end = stringEnd(line, i, c);
      push(out, 'string', line.slice(i, end));
      i = end;
      continue;
    }
    if (c === '`') { state.template = true; push(out, 'string', '`'); i++; continue; }
    // JSX: <Tag, </Tag, and attribute names until the tag closes.
    const open = /^<\/?([A-Za-z][\w.]*)/.exec(rest);
    if (open && !/[\w$]/.test(line[i - 1] ?? '')) {
      push(out, 'punct', rest.startsWith('</') ? '</' : '<');
      push(out, /^[A-Z]/.test(open[1]) ? 'type' : 'tag', open[1]);
      i += open[0].length;
      state.tag = true;
      continue;
    }
    if (state.tag && (rest.startsWith('/>') || c === '>')) {
      push(out, 'punct', rest.startsWith('/>') ? '/>' : '>');
      i += rest.startsWith('/>') ? 2 : 1;
      state.tag = false;
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(rest);
    if (number && !/[\w$]/.test(line[i - 1] ?? '')) { push(out, 'number', number[0]); i += number[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const text = word[0];
      const after = line.slice(i + text.length);
      let kind: TokenKind = 'plain';
      if (state.tag && /^=(?!=)/.test(after)) kind = 'attr';
      else if (KEYWORDS.has(text)) kind = 'keyword';
      else if (/^[A-Z]/.test(text)) kind = 'type';
      else if (/^\s*\(/.test(after)) kind = 'func';
      else if (/^\??:/.test(after) && !state.tag) kind = 'prop';
      push(out, kind, text);
      i += text.length;
      continue;
    }
    push(out, /[{}()[\];,.<>=:?!&|+\-*/%]/.test(c) ? 'punct' : 'plain', c);
    i++;
  }
  return out;
}

function cssLine(line: string, state: State): Token[] {
  const out: Token[] = [];
  let i = 0;
  // `state.tag` stands for "inside a rule's braces" here.
  while (i < line.length) {
    if (state.comment) {
      const end = line.indexOf('*/', i);
      if (end < 0) { push(out, 'comment', line.slice(i)); return out; }
      push(out, 'comment', line.slice(i, end + 2));
      i = end + 2;
      state.comment = false;
      continue;
    }
    const rest = line.slice(i);
    const c = line[i];
    if (rest.startsWith('/*')) { state.comment = true; push(out, 'comment', '/*'); i += 2; continue; }
    if (c === '{') { state.tag = true; push(out, 'punct', c); i++; continue; }
    if (c === '}') { state.tag = false; push(out, 'punct', c); i++; continue; }
    if (c === '"' || c === "'") {
      const end = stringEnd(line, i, c);
      push(out, 'string', line.slice(i, end));
      i = end;
      continue;
    }
    // A declaration: "prop: value;" (top-level dev-mode CSS has no braces, so a colon decides).
    const decl = /^(\s*)(-{0,2}[a-zA-Z][\w-]*)(\s*:)/.exec(rest);
    if (decl && (state.tag || i === 0) && !/^\s*[.#&:@]/.test(rest)) {
      push(out, 'plain', decl[1]);
      push(out, decl[2].startsWith('--') ? 'attr' : 'prop', decl[2]);
      push(out, 'punct', decl[3]);
      i += decl[0].length;
      while (i < line.length && line[i] !== ';' && !line.startsWith('/*', i) && line[i] !== '}') {
        const valueRest = line.slice(i);
        const color = /^#[0-9a-fA-F]{3,8}\b/.exec(valueRest);
        const num = /^-?\d*\.?\d+(px|%|em|rem|deg|s|ms|vh|vw|fr|ch)?/.exec(valueRest);
        const fn = /^[a-zA-Z-]+(?=\()/.exec(valueRest);
        const quote = valueRest[0] === '"' || valueRest[0] === "'";
        if (quote) { const end = stringEnd(line, i, valueRest[0]); push(out, 'string', line.slice(i, end)); i = end; }
        else if (color) { push(out, 'number', color[0]); i += color[0].length; }
        else if (num && !/[\w-]/.test(line[i - 1] ?? '')) { push(out, 'number', num[0]); i += num[0].length; }
        else if (fn) { push(out, 'func', fn[0]); i += fn[0].length; }
        else {
          const word = /^[\w-]+/.exec(valueRest);
          if (word) { push(out, 'value', word[0]); i += word[0].length; }
          else { push(out, /[(),/]/.test(line[i]) ? 'punct' : 'plain', line[i]); i++; }
        }
      }
      continue;
    }
    const selector = /^[^{]+/.exec(rest);
    if (!state.tag && selector) {
      push(out, 'selector', selector[0].trimEnd());
      push(out, 'plain', selector[0].slice(selector[0].trimEnd().length));
      i += selector[0].length;
      continue;
    }
    push(out, /[;:]/.test(c) ? 'punct' : 'plain', c);
    i++;
  }
  return out;
}

function jsonLine(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      const end = stringEnd(line, i, '"');
      const isKey = /^\s*:/.test(line.slice(end));
      push(out, isKey ? 'prop' : 'string', line.slice(i, end));
      i = end;
      continue;
    }
    const literal = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(line.slice(i));
    if (literal) { push(out, /^[tfn]/.test(literal[0]) ? 'keyword' : 'number', literal[0]); i += literal[0].length; continue; }
    push(out, /[{}[\]:,]/.test(c) ? 'punct' : 'plain', c);
    i++;
  }
  return out;
}

/** A single-file component: its <script> blocks as TypeScript, its <style> as CSS, the rest (the template) as HTML. */
function vueLine(line: string, state: State): Token[] {
  const open = /^<(script|style)\b/.exec(line);
  if (open) {
    state.block = open[1] as 'script' | 'style';
    return htmlLine(line, state);
  }
  if (/^<\/(script|style)>/.test(line)) {
    state.block = null;
    return htmlLine(line, state);
  }
  return state.block === 'script' ? scriptLine(line, state) : state.block === 'style' ? cssLine(line, state) : htmlLine(line, state);
}

function htmlLine(line: string, state: State): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (state.comment || rest.startsWith('<!--')) {
      const end = line.indexOf('-->', i);
      state.comment = end < 0;
      const stop = end < 0 ? line.length : end + 3;
      push(out, 'comment', line.slice(i, stop));
      i = stop;
      continue;
    }
    const open = /^<\/?!?([A-Za-z][\w-]*)/.exec(rest);
    if (open) {
      push(out, 'punct', rest.slice(0, open[0].length - open[1].length));
      push(out, 'tag', open[1]);
      i += open[0].length;
      state.tag = true;
      continue;
    }
    if (state.tag) {
      if (rest.startsWith('/>') || rest[0] === '>') { push(out, 'punct', rest.startsWith('/>') ? '/>' : '>'); i += rest.startsWith('/>') ? 2 : 1; state.tag = false; continue; }
      if (rest[0] === '"' || rest[0] === "'") { const end = stringEnd(line, i, rest[0]); push(out, 'string', line.slice(i, end)); i = end; continue; }
      const name = /^[\w:-]+/.exec(rest);
      if (name) { push(out, 'attr', name[0]); i += name[0].length; continue; }
    }
    push(out, 'plain', line[i]);
    i++;
  }
  return out;
}

function mdLine(line: string, fence: {open: boolean}): Token[] {
  if (/^```/.test(line)) {
    fence.open = !fence.open;
    return [{kind: 'comment', text: line}];
  }
  if (fence.open) return line ? [{kind: 'string', text: line}] : [];
  if (/^#{1,6}\s/.test(line)) return [{kind: 'heading', text: line}];
  const out: Token[] = [];
  const parts = line.split(/(`[^`]+`)/);
  for (const part of parts) push(out, part.startsWith('`') && part.endsWith('`') && part.length > 1 ? 'string' : 'plain', part);
  return out;
}
