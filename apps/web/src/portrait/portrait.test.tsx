import { publicImageUrl } from '@opensamguk/shared/public-images';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
const fallbackUrl = publicImageUrl('apps/web/src/portrait/fallback.svg');
import { Portrait } from './Portrait';
import {
  DEFAULT_IMAGE_BASE_URL,
  imageBaseUrl,
  isPortraitId,
  portraitIdOf,
  portraitUrl,
  resolveImageBaseUrl,
} from './portraitUrl';

afterEach(cleanup);

const BASE = 'https://images.example.test/v1';

describe('portraitUrl', () => {
  it('보충 8명은 외부 base와 무관하게 개발 서버 원본을 쓴다', () => {
    for (let id = 11001; id <= 11008; id++) {
      expect(portraitUrl(id, 'portrait', BASE)).toBe(`/__dev-portraits/${id}`);
      expect(portraitUrl(id, 'icon', BASE)).toBe(`/__dev-portraits/${id}`);
    }
  });
  it('id 10006은 변형마다 경로와 확장자가 다르다', () => {
    expect(portraitUrl(10006, 'portrait', BASE)).toBe(`${BASE}/portraits/portrait/10006.png`);
    expect(portraitUrl(10006, 'icon', BASE)).toBe(`${BASE}/portraits/icon/10006.webp`);
    expect(portraitUrl(10006, 'thumb', BASE)).toBe(`${BASE}/portraits/thumb/10006.webp`);
  });

  it('base URL만 바꾸면 주소가 바뀐다', () => {
    expect(portraitUrl(10006, 'icon', 'https://other.example.test')).toBe(
      'https://other.example.test/portraits/icon/10006.webp',
    );
  });

  it('범위 끝 10001·11000은 주소를 만든다', () => {
    expect(portraitUrl(10001, 'thumb', BASE)).toBe(`${BASE}/portraits/thumb/10001.webp`);
    expect(portraitUrl(11000, 'thumb', BASE)).toBe(`${BASE}/portraits/thumb/11000.webp`);
  });

  it('범위 밖·null·정수 아님은 null (기본 이미지)', () => {
    for (const id of [null, undefined, 0, 10000, 11009, 10006.5, Number.NaN]) {
      expect(isPortraitId(id)).toBe(false);
      expect(portraitUrl(id, 'portrait', BASE)).toBeNull();
    }
  });

  it('base를 주지 않으면 설정값을 쓴다', () => {
    expect(portraitUrl(10006, 'portrait')).toBe(`${imageBaseUrl}/portraits/portrait/10006.png`);
  });
});

describe('resolveImageBaseUrl', () => {
  it('비었으면 GitHub 원본 고정 커밋 주소', () => {
    expect(resolveImageBaseUrl(undefined)).toBe(DEFAULT_IMAGE_BASE_URL);
    expect(resolveImageBaseUrl('  ')).toBe(DEFAULT_IMAGE_BASE_URL);
    expect(DEFAULT_IMAGE_BASE_URL).toBe(
      'https://raw.githubusercontent.com/opensamguk/opensamguk-images/947cee861126310596c4342b5e785332d9644264',
    );
  });

  it('끝의 /와 공백은 뗀다', () => {
    expect(resolveImageBaseUrl(' https://img.example.test/a// ')).toBe('https://img.example.test/a');
    expect(resolveImageBaseUrl('/images/')).toBe('/images');
  });
});

describe('Portrait', () => {
  it('초상 ID가 있으면 해석한 주소를 쓰고 alt는 장수 이름', () => {
    render(<Portrait id={10002} name="정원" variant="icon" />);
    const img = screen.getByRole('img', { name: '정원' });
    expect(img.getAttribute('src')).toBe(portraitUrl(10002, 'icon'));
    expect(img.closest('[data-state]')?.getAttribute('data-state')).toBe('image');
    expect(img.getAttribute('width')).toBe('96');
  });

  it('null이면 실루엣과 이름 첫 글자', () => {
    const { container } = render(<Portrait id={null} name="유비" />);
    const img = screen.getByRole('img', { name: '유비' });
    expect(img.getAttribute('src')).toBe(fallbackUrl);
    expect(container.querySelector('[data-state]')?.getAttribute('data-state')).toBe('fallback');
    expect(container.textContent).toBe('유');
  });

  it('범위 밖 ID도 기본 이미지', () => {
    render(<Portrait id={9999} name="관우" variant="thumb" />);
    expect(screen.getByRole('img', { name: '관우' }).getAttribute('src')).toBe(fallbackUrl);
  });

  it('불러오기에 실패하면 기본 이미지로 바뀐다', () => {
    render(<Portrait id={10002} name="정원" />);
    fireEvent.error(screen.getByRole('img', { name: '정원' }));
    const img = screen.getByRole('img', { name: '정원' });
    expect(img.getAttribute('src')).toBe(fallbackUrl);
    expect(img.closest('[data-state]')?.getAttribute('data-state')).toBe('fallback');
  });

  it('실패 뒤 다른 ID로 바뀌면 다시 시도한다', () => {
    const { rerender } = render(<Portrait id={10002} name="정원" />);
    fireEvent.error(screen.getByRole('img', { name: '정원' }));
    rerender(<Portrait id={11000} name="공도" />);
    expect(screen.getByRole('img', { name: '공도' }).getAttribute('src')).toBe(portraitUrl(11000, 'portrait'));
  });
});

describe('INT-25 줄인 초상과 이름 옆 초상', () => {
  it('size는 폭을 정하고 높이는 변형 비율을 따른다', () => {
    const { container } = render(<Portrait id={10002} name="정원" variant="thumb" size={20} />);
    const frame = container.querySelector<HTMLElement>('[data-variant="thumb"]')!;
    expect([frame.style.width, frame.style.height]).toEqual(['20px', '28px']);
  });

  it('원형은 icon에만 붙는다', () => {
    const { container } = render(
      <>
        <Portrait id={10002} name="정원" variant="icon" shape="round" />
        <Portrait id={10002} name="정원" variant="thumb" shape="round" />
      </>,
    );
    const [icon, thumb] = Array.from(container.querySelectorAll('[data-variant]'));
    expect(icon?.className.split(' ')).toHaveLength(3);
    expect(thumb?.className.split(' ')).toHaveLength(2);
  });

  it('decorative면 alt를 비워 이름을 두 번 읽지 않는다', () => {
    const { container } = render(<Portrait id={null} name="유비" variant="icon" decorative />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(screen.queryByRole('img', { name: '유비' })).toBeNull();
    // 첫 글자는 CSS로만 그려 옆 이름과 함께 읽히는 글자에 섞이지 않는다.
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-initial]')?.getAttribute('data-initial')).toBe('유');
  });

  it('portraitIdOf는 응답에 숫자 portraitId가 있을 때만 그 값을 준다', () => {
    expect(portraitIdOf({ portraitId: 10006 })).toBe(10006);
    expect(portraitIdOf({ portraitId: null })).toBeNull();
    expect(portraitIdOf({ name: '조조' })).toBeNull();
    expect(portraitIdOf(undefined)).toBeNull();
  });
});
