// Picture input checks shared by the design tool's uploads and its PDF export. Only the raster check is carried over: the design
// tool accepts raster pictures alone (server/design/images.ts re-encodes them), so there is no SVG sanitizer.

/** Recognize only supported raster containers before calling sharp. SVG/SVGZ,
 * XML entities and disguised text must never reach the decoder. */
export function isRasterImageInput(data: Buffer) {
  return (
    data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') ||
    /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)) ||
    data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
    data.subarray(0, 4).equals(Buffer.from([73, 73, 43, 0])) ||
    data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 43])) ||
    data.toString('ascii', 4, 8) === 'ftyp'
  );
}
