import { expect, it } from 'vitest';
import provenance from './icons/sources.json';
import images from '@opensamguk/shared/tool-images' with { type: 'json' };
it('이미지 저장소로 옮긴 표식의 고정 해시가 원래 출처 기록과 같다', () => {
  expect(provenance.assets.map((a) => a.kind)).toEqual(['city', 'pass', 'port', 'field']);
  for (const asset of provenance.assets) {
    const image = images.find((image) => image.source === `apps/web/src/mapEditor/icons/${asset.kind}.png`);
    expect(image?.sha256).toBe(asset.sha256);
    expect(image?.bytes).toBe(asset.bytes);
    expect(image?.url).toMatch(/\/opensamguk-images\/[a-f0-9]{40}\/public\/mapEditor\/icons\//);
  }
});
