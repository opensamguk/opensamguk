import { crc32, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const portraitMaxBytes = 350_000;

export function readPlayerPortrait(value: string): Buffer | null {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 45 || bytes.length > portraitMaxBytes || bytes.toString('base64') !== value) return null;
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (
    !width ||
    !height ||
    width > 256 ||
    height > 256 ||
    !channels ||
    bytes[24] !== 8 ||
    bytes.subarray(26, 29).some(Boolean)
  )
    return null;

  const kept = [signature];
  const pixels: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > bytes.length || (offset === 8 && (type !== 'IHDR' || length !== 13))) return null;
    const chunk = bytes.subarray(offset, end);
    if (crc32(chunk.subarray(4, -4)) !== chunk.readUInt32BE(chunk.length - 4)) return null;
    if (type === 'IHDR' && offset === 8) kept.push(chunk);
    else if (type === 'IDAT') {
      kept.push(chunk);
      pixels.push(bytes.subarray(offset + 8, end - 4));
    } else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || pixels.length === 0) return null;
      const stride = width * channels + 1;
      try {
        const decoded = inflateSync(Buffer.concat(pixels), { maxOutputLength: stride * height });
        if (decoded.length !== stride * height) return null;
        for (let row = 0; row < height; row++) if (decoded[row * stride]! > 4) return null;
      } catch {
        return null;
      }
      return Buffer.concat([...kept, chunk]);
    } else if (type.charAt(0) === type.charAt(0).toUpperCase()) return null;
    offset = end;
  }
  return null;
}
