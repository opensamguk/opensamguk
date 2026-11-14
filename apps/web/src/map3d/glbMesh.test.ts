import { describe, expect, it } from 'vitest';
import { parseGlb } from './glbMesh';

// INT-27 D-094: 거점 모형 GLB 읽기 (GLTFLoader 없이 JSON·BIN 덩어리를 꺼낸다).
function glb(json: object, bin: Uint8Array) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonLength = text.length + pad(text.length);
  const binLength = bin.length + pad(bin.length);
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  const binAt = 20 + jsonLength;
  view.setUint32(binAt, binLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out.buffer;
}

describe('parseGlb', () => {
  it('JSON과 BIN 덩어리를 꺼낸다', () => {
    const bin = new Uint8Array([1, 2, 3, 4]);
    const { json, bin: out } = parseGlb(glb({ asset: { version: '2.0' }, meshes: [] }, bin));
    expect((json as unknown as { asset: { version: string } }).asset.version).toBe('2.0');
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3, 4]);
  });

  it('GLB가 아니면 거절한다', () => {
    expect(() => parseGlb(new Uint8Array(20).buffer)).toThrow();
  });
});
