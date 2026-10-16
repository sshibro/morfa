import type {RGB} from '../../../shared/design/types';

// Hex for the prototype's colour rows (ColorField.tsx); pure, so node tests reach it without the picker.

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
export const toHex = (color: RGB) => (channel(color.r) + channel(color.g) + channel(color.b)).toUpperCase();

/** '#1E1E1E', '1e1e1e' or '1E1' → RGB, else null. */
export function parseHex(text: string): RGB | null {
  let hex = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const value = parseInt(hex, 16);
  return {r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255};
}
