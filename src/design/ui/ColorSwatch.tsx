import type {ButtonHTMLAttributes, CSSProperties, Ref} from 'react';
import type {RGB, RGBA} from '../../../shared/design/types';

/** Model colours are 0..1 channels; CSS wants 0..255. */
export function cssColor(color: RGB | RGBA | string, opacity = 1): string {
  if (typeof color === 'string') return color;
  const alpha = ('a' in color ? color.a : 1) * opacity;
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(color.r)} ${channel(color.g)} ${channel(color.b)} / ${Math.round(alpha * 1000) / 1000})`;
}

export type ColorSwatchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> & {
  color: RGB | RGBA | string;
  /** Paint opacity on top of the colour's own alpha. */
  opacity?: number;
  size?: 14 | 16 | 20 | 24;
  /** A clickable swatch (it opens a picker); otherwise a plain mark. */
  interactive?: boolean;
  /** The left half drawn opaque, as Figma's fill rows show a translucent colour. */
  split?: boolean;
  'aria-label'?: string;
  ref?: Ref<HTMLButtonElement>;
};

/** A colour chip: a checkerboard shows through whatever is not opaque; a hairline keeps white visible on white. */
export function ColorSwatch({color, opacity = 1, size = 14, interactive = false, split = false, className = '', ref, ...rest}: ColorSwatchProps) {
  const paint = cssColor(color, opacity);
  const solid = typeof color === 'string' ? color : cssColor({r: color.r, g: color.g, b: color.b});
  const style = {'--dz-swatch': paint, '--dz-swatch-solid': solid, width: size, height: size} as CSSProperties;
  const classes = `dz-swatch ${split ? 'is-split' : ''} ${className}`.trim();
  if (!interactive) return <span className={classes} style={style} role="img" aria-label={rest['aria-label']} aria-hidden={rest['aria-label'] ? undefined : true} />;
  return <button ref={ref} type="button" className={`${classes} is-interactive`} style={style} {...rest} />;
}
