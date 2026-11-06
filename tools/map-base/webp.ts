// 이미지 해독 없이 무손실 WebP의 청크 구조와 캔버스 크기를 읽는다.
export function readWebpSize(bytes: Buffer): { width: number; height: number } {
  const invalid = () => {
    throw new Error('무손실 WebP 파일을 확인하세요.');
  };
  if (
    bytes.length < 12 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  )
    return invalid();
  let canvas: { width: number; height: number } | undefined;
  let image: { width: number; height: number } | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return invalid();
    const tag = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      start = offset + 8;
    const end = start + size;
    if (end + (size & 1) > bytes.length || (size & 1 && bytes[end] !== 0)) return invalid();
    if (tag === 'VP8X') {
      if (canvas || image || size !== 10 || bytes[start]! & 0xc3 || bytes.readUIntLE(start + 1, 3) !== 0)
        return invalid();
      canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
    } else if (tag === 'VP8L') {
      if (image || size < 5 || bytes[start] !== 0x2f) return invalid();
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) return invalid();
      image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (['VP8 ', 'ANIM', 'ANMF'].includes(tag)) return invalid();
    offset = end + (size & 1);
  }
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) return invalid();
  return image;
}
