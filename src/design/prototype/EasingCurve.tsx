import {memo, useEffect, useMemo, useRef} from 'react';
import type {Easing} from '../../../shared/design/types';
import {easingPath, evaluateEasing} from '../../../shared/design/prototype';

// The easing's curve: time to the right, progress up; the dashed lines are the start and the end
// (back and spring curves cross them). Pointing at it plays a dot along the curve at the
// transition's real length, which shows the motion better than its shape does.

const WIDTH = 232;
const HEIGHT = 48;
const PAD = 6;

export const EasingCurve = memo(function EasingCurve({easing, seconds}: {easing: Easing; seconds: number}) {
  const path = useMemo(() => easingPath(easing, WIDTH - 2 * PAD, HEIGHT - 2 * PAD), [easing]);
  const dot = useRef<SVGCircleElement>(null);
  const animation = useRef<Animation | null>(null);
  const play = () => {
    const element = dot.current;
    if (!element || typeof element.animate !== 'function') return;
    animation.current?.cancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const frames: Keyframe[] = [];
    const inner = HEIGHT - 2 * PAD;
    const low = Math.min(0, ...Array.from({length: 33}, (_, i) => evaluateEasing(easing, i / 32)));
    const high = Math.max(1, ...Array.from({length: 33}, (_, i) => evaluateEasing(easing, i / 32)));
    for (let i = 0; i <= 32; i++) {
      const value = evaluateEasing(easing, i / 32);
      const x = (i / 32) * (WIDTH - 2 * PAD);
      const y = inner - ((value - low) / (high - low)) * inner;
      frames.push({transform: `translate(${x}px, ${y}px)`, offset: i / 32});
    }
    element.style.opacity = '1';
    animation.current = element.animate(frames, {duration: Math.max(120, seconds * 1000), easing: 'linear', fill: 'forwards'});
    animation.current.onfinish = () => {
      element.style.opacity = '';
    };
  };
  // A new curve plays once, so the choice is seen as well as drawn.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    play();
  }, [easing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => animation.current?.cancel(), []);
  return (
    <svg className="dz-proto-curve" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Animation curve" onPointerEnter={play}>
      <g transform={`translate(${PAD} ${PAD})`}>
        <line className="dz-proto-curve__guide" x1={0} x2={WIDTH - 2 * PAD} y1={path.zeroY} y2={path.zeroY} />
        <line className="dz-proto-curve__guide" x1={0} x2={WIDTH - 2 * PAD} y1={path.oneY} y2={path.oneY} />
        <path className="dz-proto-curve__line" d={path.d} />
        <circle ref={dot} className="dz-proto-curve__dot" r={3.5} cx={0} cy={0} style={{transform: `translate(0px, ${path.zeroY}px)`}} />
      </g>
    </svg>
  );
});
