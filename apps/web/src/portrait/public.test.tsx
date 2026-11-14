import { publicImageUrl } from '@opensamguk/shared/public-images';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fallbackUrl = publicImageUrl('apps/web/src/portrait/fallback.svg');
import { Portrait } from './Portrait';
import { PORTRAIT_VARIANTS, type PortraitVariant } from './portraitUrl';

// D-087: 공개 빌드(`vite build --mode public`)도 개발과 같은 base로 게임 초상을 보인다.
// 실제 번들에서는 MODE가 빌드 때 상수로 바뀐다. 여기서는 같은 값을 vi.stubEnv로 넣는다.
// 일반 모드 시험은 portrait.test.tsx에 그대로 있다. 이 파일은 끝날 때마다 환경값과 모듈 목록을 되돌린다.

const VARIANTS = Object.keys(PORTRAIT_VARIANTS) as PortraitVariant[];
const PINNED_BASE =
  'https://raw.githubusercontent.com/opensamguk/opensamguk-images/8d96c8d5d3ba2b7c6e4f208730a2ac4bd2366da4';

beforeEach(() => {
  vi.stubEnv('MODE', 'public');
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_IMAGE_BASE_URL', '');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 모듈 머리의 상수는 처음 읽을 때 정해지므로 환경값을 넣은 뒤 새로 읽는다.
async function freshModules() {
  vi.resetModules();
  const [url, component] = await Promise.all([import('./portraitUrl'), import('./Portrait')]);
  return { ...url, Portrait: component.Portrait };
}

describe('공개 빌드의 portraitUrl', () => {
  it('base가 비면 고정 커밋 기본값으로 세 변형 주소를 만든다', async () => {
    const fresh = await freshModules();
    expect(fresh.imageBaseUrl).toBe(PINNED_BASE);
    expect(fresh.portraitUrl(10006, 'portrait')).toBe(`${PINNED_BASE}/portraits/portrait/10006.png`);
    expect(fresh.portraitUrl(10006, 'icon')).toBe(`${PINNED_BASE}/portraits/icon/10006.webp`);
    expect(fresh.portraitUrl(10006, 'thumb')).toBe(`${PINNED_BASE}/portraits/thumb/10006.webp`);
  });

  it('VITE_IMAGE_BASE_URL을 주면 공개 빌드도 그 값을 쓴다', async () => {
    vi.stubEnv('VITE_IMAGE_BASE_URL', 'https://img.example.test/set/');
    const fresh = await freshModules();
    expect(fresh.imageBaseUrl).toBe('https://img.example.test/set');
    expect(fresh.portraitUrl(10002, 'icon')).toBe('https://img.example.test/set/portraits/icon/10002.webp');
  });

  it('범위 밖·null과 보충 8명은 null (기본 이미지)', async () => {
    const fresh = await freshModules();
    for (const id of [null, undefined, 10000, 11009, 11001, 11008]) {
      for (const variant of VARIANTS) expect(fresh.portraitUrl(id, variant)).toBeNull();
    }
  });

  it('ID 범위와 변형·크기 계약은 그대로다', async () => {
    const fresh = await freshModules();
    expect([fresh.PORTRAIT_ID_MIN, fresh.PORTRAIT_ID_MAX]).toEqual([10001, 11008]);
    expect(fresh.PORTRAIT_VARIANTS).toEqual({
      portrait: { ext: 'png', width: 148, height: 210 },
      icon: { ext: 'webp', width: 96, height: 96 },
      thumb: { ext: 'webp', width: 48, height: 68 },
    });
  });
});

describe('공개 빌드의 Portrait', () => {
  it('유효한 ID는 세 변형 모두 초상 그림을 보인다', async () => {
    const { Portrait: FreshPortrait } = await freshModules();
    for (const variant of VARIANTS) {
      const { container, unmount } = render(<FreshPortrait id={10002} name="정원" variant={variant} />);
      const img = screen.getByRole('img', { name: '정원' });
      expect(img.getAttribute('src')).toBe(
        `${PINNED_BASE}/portraits/${variant}/10002.${PORTRAIT_VARIANTS[variant].ext}`,
      );
      expect(img.getAttribute('width')).toBe(String(PORTRAIT_VARIANTS[variant].width));
      const frame = container.querySelector('[data-state]');
      expect(frame?.getAttribute('data-state')).toBe('image');
      expect(frame?.getAttribute('data-variant')).toBe(variant);
      unmount();
    }
  });

  it('초상 ID가 없으면 실루엣과 이름 첫 글자', () => {
    const { container } = render(<Portrait id={null} name="공도" variant="thumb" />);
    expect(screen.getByRole('img', { name: '공도' }).getAttribute('src')).toBe(fallbackUrl);
    expect(container.textContent).toBe('공');
  });

  it('그림을 못 불러오면 실루엣으로 바뀌고 다른 주소로 가지 않는다', async () => {
    const { Portrait: FreshPortrait } = await freshModules();
    render(<FreshPortrait id={10002} name="정원" />);
    fireEvent.error(screen.getByRole('img', { name: '정원' }));
    const img = screen.getByRole('img', { name: '정원' });
    expect(img.getAttribute('src')).toBe(fallbackUrl);
    expect(img.closest('[data-state]')?.getAttribute('data-state')).toBe('fallback');
  });
});
