/** Only public, absolute origins may enter build configuration or navigation (vite.config.ts). */
export function webOrigin(value: string, production: boolean): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      (production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))) {
    throw new Error('Web origins must be absolute HTTPS origins without credentials, paths or trailing slashes.');
  }
  return url.origin;
}
