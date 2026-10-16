/** A display name: control characters out, spaces trimmed, at most `max` characters; empty is null. */
export function cleanName(value: string | undefined, max = 200): string | null {
  const name = (value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return name ? [...name].slice(0, max).join('').trim() : null;
}
