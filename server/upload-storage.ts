// Upload helpers the design tool's routes use: the name a picture keeps, and gates of simultaneous jobs. There is no site
// image library (storage, quotas, variants) in Morfa.

/** A picture's file name as the person gave it, without a path, control characters or more than 120 characters. */
export function uploadedImageName(name: string) {
  return name
    .split(/[\\/]/)
    .pop()!
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
}

export function multipartImageName(value: string) {
  // Busboy decodes a regular multipart filename as Latin-1, while browsers send
  // UTF-8 bytes. Decode only a valid byte sequence; already-decoded Unicode and
  // genuine non-UTF-8 legacy names retain their original spelling.
  if ([...value].every(char => char.charCodeAt(0) <= 255))
    try {
      value = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(value, 'latin1'));
    } catch {}
  return uploadedImageName(value);
}

/** A gate of simultaneous jobs: `perAccount` for one account, `platform` for everyone. `take` returns the release, or null when full. */
export function slotGate(perAccount: number, platform: number) {
  const active = new Map<string, number>();
  let total = 0;
  return (userId: string) => {
    if (total >= platform || (active.get(userId) || 0) >= perAccount) return null;
    total++;
    active.set(userId, (active.get(userId) || 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      total--;
      const n = (active.get(userId) || 1) - 1;
      if (n) active.set(userId, n);
      else active.delete(userId);
    };
  };
}
