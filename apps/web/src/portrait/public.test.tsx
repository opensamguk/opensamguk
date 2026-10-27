// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fallbackUrl from './fallback.svg';
import { Portrait } from './Portrait';
import { PORTRAIT_ID_MAX, PORTRAIT_ID_MIN, PORTRAIT_VARIANTS, portraitUrl, type PortraitVariant } from './portraitUrl';

// T3-13 · D-031: 공개 빌드(`vite build --mode public`)에서는 초상이 늘 기본 이미지다.
// 실제 번들에서는 MODE가 빌드 때 상수로 바뀐다. 여기서는 같은 값을 vi.stubEnv로 넣는다.
// 일반 모드 시험은 portrait.test.tsx에 그대로 있다. 이 파일은 끝날 때마다 환경값과 모듈 목록을 되돌린다.

const VARIANTS = Object.keys(PORTRAIT_VARIANTS) as PortraitVariant[];
const VALID_IDS = [PORTRAIT_ID_MIN, 10002, 10006, PORTRAIT_ID_MAX];
const EXPLICIT_BASES = [
  'https://cdn.jsdelivr.net/gh/peppone-choi/opensamguk-images@48163bd',
  'https://img.example.test',
];

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
async function freshPortraitUrl() {
  vi.resetModules();
  return import('./portraitUrl');
}

describe('공개 빌드의 portraitUrl', () => {
  it('유효한 ID와 세 변형 모두 null', async () => {
    const fresh = await freshPortraitUrl();
    for (const id of VALID_IDS) {
      for (const variant of VARIANTS) {
        expect(fresh.isPortraitId(id)).toBe(true);
        expect(fresh.portraitUrl(id, variant)).toBeNull();
      }
    }
  });

  it('base 인자를 직접 줘도 null', async () => {
    const fresh = await freshPortraitUrl();
    for (const base of EXPLICIT_BASES) {
      for (const variant of VARIANTS) {
        expect(fresh.portraitUrl(10002, variant, base)).toBeNull();
      }
    }
  });

  it('기본값과 설정값은 빈 값이다', async () => {
    const fresh = await freshPortraitUrl();
    expect(fresh.DEFAULT_IMAGE_BASE_URL).toBe('');
    expect(fresh.imageBaseUrl).toBe('');
  });

  it('ID 범위와 변형·크기 계약은 그대로다', async () => {
    const fresh = await freshPortraitUrl();
    expect([fresh.PORTRAIT_ID_MIN, fresh.PORTRAIT_ID_MAX]).toEqual([10001, 11008]);
    expect(fresh.PORTRAIT_VARIANTS).toEqual({
      portrait: { ext: 'png', width: 148, height: 210 },
      icon: { ext: 'webp', width: 96, height: 96 },
      thumb: { ext: 'webp', width: 48, height: 68 },
    });
  });
});

describe('공개 빌드의 Portrait', () => {
  it('유효한 ID도 세 변형 모두 기본 이미지와 이름 첫 글자', () => {
    for (const variant of VARIANTS) {
      const { container, unmount } = render(<Portrait id={10002} name="정원" variant={variant} />);
      const img = screen.getByRole('img', { name: '정원' });
      expect(img.getAttribute('src')).toBe(fallbackUrl);
      expect(img.getAttribute('src')).not.toMatch(/portraits|jsdelivr/);
      expect(img.getAttribute('width')).toBe(String(PORTRAIT_VARIANTS[variant].width));
      const frame = container.querySelector('[data-state]');
      expect(frame?.getAttribute('data-state')).toBe('fallback');
      expect(frame?.getAttribute('data-variant')).toBe(variant);
      expect(container.textContent).toBe('정');
      unmount();
    }
  });

  it('범위 끝 ID와 null도 기본 이미지', () => {
    for (const id of [PORTRAIT_ID_MIN, PORTRAIT_ID_MAX, null]) {
      const { unmount } = render(<Portrait id={id} name="공도" variant="thumb" />);
      expect(screen.getByRole('img', { name: '공도' }).getAttribute('src')).toBe(fallbackUrl);
      unmount();
    }
  });

  it('기본 이미지에서 오류가 나도 다른 주소로 가지 않는다', () => {
    render(<Portrait id={10002} name="정원" />);
    fireEvent.error(screen.getByRole('img', { name: '정원' }));
    const img = screen.getByRole('img', { name: '정원' });
    expect(img.getAttribute('src')).toBe(fallbackUrl);
    expect(img.closest('[data-state]')?.getAttribute('data-state')).toBe('fallback');
  });

  it('정적으로 읽은 portraitUrl도 호출 때 공개 모드를 따른다', () => {
    expect(portraitUrl(10002, 'portrait', 'https://img.example.test')).toBeNull();
  });
});
