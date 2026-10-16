import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {highlight, type CodeLanguage} from './highlight';

// Read-only, highlighted code. Only the lines in view (plus a margin) are in the DOM, so a 5 000-line
// screen scrolls as lightly as a ten-line component. Lines never wrap: the block scrolls sideways,
// sized by its longest line.

const LINE = 18;
const PAD = 8;
const OVERSCAN = 12;

export type CodeViewProps = {
  code: string;
  language: CodeLanguage;
  /** The tallest the block grows before it scrolls (lines). */
  maxLines?: number;
  label: string;
};

export const CodeView = memo(function CodeView({code, language, maxLines = 28, label}: CodeViewProps) {
  const lines = useMemo(() => highlight(code, language), [code, language]);
  const longest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.reduce((sum, token) => sum + token.text.length, 0)), 0), [lines]);
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({start: 0, end: maxLines + OVERSCAN});
  const frame = useRef(0);
  const visible = Math.min(lines.length, maxLines);

  const measure = useCallback(() => {
    frame.current = 0;
    const element = scroller.current;
    if (!element) return;
    const first = Math.max(0, Math.floor((element.scrollTop - PAD) / LINE) - OVERSCAN);
    const last = Math.min(lines.length, Math.ceil((element.scrollTop + element.clientHeight) / LINE) + OVERSCAN);
    setRange(previous => (previous.start === first && previous.end === last ? previous : {start: first, end: last}));
  }, [lines.length]);

  useEffect(() => {
    measure();
    return () => cancelAnimationFrame(frame.current);
  }, [measure, code]);

  // A new file starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({top: 0, left: 0});
  }, [code]);

  const onScroll = () => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
  };

  const shown = lines.slice(range.start, range.end);
  return (
    <div ref={scroller} className="dz-code-scroll" style={{height: visible * LINE + PAD * 2}} onScroll={onScroll}
      role="region" aria-label={label} tabIndex={0}>
      <div className="dz-code-lines" style={{height: lines.length * LINE + PAD * 2, minWidth: `calc(${longest}ch + 24px)`}}>
        <pre className="dz-code-pre" style={{transform: `translateY(${range.start * LINE}px)`}}>
          {shown.map((tokens, index) => (
            <div key={range.start + index} className="dz-code-line">
              {tokens.length ? tokens.map((token, k) => (token.kind === 'plain' ? token.text : <span key={k} className={`dz-tok-${token.kind}`}>{token.text}</span>)) : '​'}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});
