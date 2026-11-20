// 성 화면 미리보기 아티팩트 진입점. 그림 묶음(index.json, <양식>-<n>.bin, tools/art/pack-castle-preview.py)을 받아
// blob 주소로 바꾼 뒤 개발용 성 화면 판(DevCastlePage)을 띄운다. 양식을 바꾸면 그 양식 묶음을 그때 받는다.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PUBLIC_IMAGES } from './publicImagesShim';

interface Index {
  groups: Record<string, string[]>;
  items: Record<string, [string, number, number]>;
}
const art = ((globalThis as { __CASTLE_ART?: Map<string, string> }).__CASTLE_ART ??= new Map());
const done = new Map<string, Promise<void>>();
const missing: string[] = [];

/** 묶음 하나를 받는다. 디스크 캐시에 쓰지 않고(C:가 차 있으면 캐시 쓰기에서 실패한다) 세 번까지 다시 받는다. */
async function fetchBin(file: string): Promise<ArrayBuffer | null> {
  for (let n = 0; n < 3; n++) {
    try {
      const res = await fetch(file, { cache: 'no-store' });
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // 다시 받는다
    }
    await new Promise((r) => setTimeout(r, 600 * (n + 1)));
  }
  missing.push(file);
  return null;
}

async function main() {
  const status = document.getElementById('status')!;
  const index = (await (await fetch('index.json', { cache: 'no-store' })).json()) as Index;
  const load = (group: string) => {
    const hit = done.get(group);
    if (hit) return hit;
    const job = (async () => {
      const files = index.groups[group] ?? [];
      const bins = new Map<string, ArrayBuffer>();
      // 한 번에 둘씩 받는다(큰 묶음을 한꺼번에 받다 끊기지 않게).
      for (let n = 0; n < files.length; n += 2)
        await Promise.all(
          files.slice(n, n + 2).map(async (file) => {
            const bin = await fetchBin(file);
            if (bin) bins.set(file, bin);
          }),
        );
      for (const [source, [file, start, len]] of Object.entries(index.items)) {
        const bin = bins.get(file);
        if (bin && !art.has(source)) {
          const url = URL.createObjectURL(new Blob([new Uint8Array(bin, start, len)], { type: 'image/webp' }));
          art.set(source, url);
          PUBLIC_IMAGES.push({ source, url, sha256: '' });
        }
      }
    })();
    done.set(group, job);
    return job;
  };
  status.textContent = '그림을 받는 중';
  await load('common');
  await load('east-okjeo-ye');
  // 못 받은 묶음이 있어도 화면은 띄운다(그 그림만 빠지고 상자 그림이나 다른 양식 그림으로 대신한다).
  if (missing.length)
    status.textContent = `그림 묶음 ${missing.length}개를 받지 못해 일부 그림이 빠졌습니다: ${missing.join(', ')}`;
  else status.remove();
  const { DevCastlePage } = await import('../DevCastlePage');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <DevCastlePage prepareStyle={(style) => load(style)} />
    </StrictMode>,
  );
}
main().catch((error: unknown) => {
  const status = document.getElementById('status');
  if (status) status.textContent = `그림을 받지 못했습니다: ${String(error)}`;
});
