// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { createElement, Fragment, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapCity } from '../game/types';
import {
  DOT_R,
  EXPORT_HEIGHT,
  EXPORT_NOTE,
  EXPORT_WIDTH,
  frameDrawing,
  HEADER_HEIGHT,
  NEUTRAL,
  pngFileName,
  safeFileName,
  type DrawOp,
} from './export';
import { frameView, type FrameNation, type NationDisplaySource, type TimelapseFrame } from './frames';
import { sharedErrorView } from './SharedTimelapsePage';
import { toSharedFrame, toSharedHead, toSharedMap, toSharedPage, type PublicFrames } from './sharedSource';
import { ShareLinkButton } from './TimelapsePanel';
import { TimelapseView, type DownloadPng } from './TimelapseView';

// T4-37 (가) 지금 달 PNG와 (나) 종료 월드 공유의 단위 시험 X1~X10 (docs/plans/T4-37.md 4.1).
// 캔버스와 실제 내려받기는 jsdom에 없으므로 Chromium E2E(e2e/timelapseExport.spec.ts, timelapseShare.spec.ts)가 본다.

afterEach(() => {
  cleanup();
});

const city = (key: number, links: number[] = []): MapCity => ({
  key,
  name: `도시${key}`,
  level: 5,
  x: key * 10,
  y: key * 20,
  nationId: 99,
  supplied: false,
  links,
});
const frame = (owners: Array<number | null>, i = 0): TimelapseFrame => ({
  tick: (i + 1) * 10_000,
  year: 190,
  month: i + 1,
  cities: owners.map((nationId, k) => ({ cityKey: k + 1, nationId })),
});
function stored(byId: Record<number, { name: string; color: string }>): NationDisplaySource {
  return {
    resolve(_tick, nationId): FrameNation {
      if (nationId === null) return { kind: 'empty' };
      const nation = byId[nationId];
      return nation ? { kind: 'stored', id: nationId, ...nation } : { kind: 'missing', id: nationId };
    },
  };
}
const okView = (view: ReturnType<typeof frameView>) => {
  if (view.kind !== 'ok') throw new Error('그릴 수 있는 달이어야 한다');
  return view;
};
const circles = (ops: readonly DrawOp[]) => ops.filter((op) => op.kind === 'circle');
const lines = (ops: readonly DrawOp[]) => ops.filter((op) => op.kind === 'line');
const texts = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'text' ? [op.text] : []));

const wei = { name: '위', color: '#000080' };
const wu = { name: '오', color: '#ff0000' };
const viewProps = { hasMore: false, nextError: false, onRetryNext: () => {}, contractError: null } as const;

describe('X1 그리기 명령', () => {
  it('도시마다 원 하나, 연결마다 선 하나이고 색은 저장된 국가 색이나 공백지 색뿐이다', () => {
    const map = [city(1, [2]), city(2, [1, 3]), city(3, [2])];
    const view = okView(frameView(frame([1, 2, null]), map, stored({ 1: wei, 2: wu })));
    const drawing = frameDrawing({ worldName: '시험 월드', date: '190년 1월', view });
    const { ops } = drawing;
    expect([drawing.width, drawing.height]).toEqual([700, 656]);
    expect(circles(ops)).toHaveLength(3);
    expect(lines(ops)).toHaveLength(2);
    expect(circles(ops).map((op) => op.kind === 'circle' && op.fill)).toEqual(['#000080', '#ff0000', NEUTRAL]);
    const first = circles(ops)[0]!;
    expect(first).toMatchObject({ x: 10, y: 20 + HEADER_HEIGHT, r: DOT_R, dashed: false });
    expect(texts(ops)[0]).toBe('시험 월드 · 190년 1월');
    expect(texts(ops)).toContain(EXPORT_NOTE);
    // 지도 도시의 지금 소유(nationId 99)·규모·보급과 도시 이름은 그림에 들어가지 않는다.
    expect(JSON.stringify(ops)).not.toContain('도시1');
    expect(ops[0]).toEqual({ kind: 'rect', x: 0, y: 0, w: EXPORT_WIDTH, h: EXPORT_HEIGHT, fill: '#ffffff' });
  });
});

describe('X2 기록 없는 달은 내려받지 않는다', () => {
  it('기록 없는 달의 버튼은 점선이고 누르면 이유를 보이며 그림 함수를 부르지 않는다', async () => {
    const download = vi.fn<DownloadPng>(() => Promise.resolve());
    render(
      createElement(TimelapseView, {
        frames: [frame([1, 2]), frame([1, 1], 1)],
        map: [city(1), city(2)],
        source: stored({ 1: wei }),
        ...viewProps,
        worldName: '시험',
        download,
      }),
    );
    const button = screen.getByRole('button', { name: '이 달 그림 내려받기' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(await screen.findByText('국가 기록이 없는 달은 내려받을 수 없습니다.')).toBeTruthy();
    expect(download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(screen.queryByText('국가 기록이 없는 달은 내려받을 수 없습니다.')).toBeNull());
    const ready = screen.getByRole('button', { name: '이 달 그림 내려받기' });
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(ready);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![0]).toMatchObject({ width: 700, height: 656 });
    expect(download.mock.calls[0]![1]).toBe('opensamguk-시험-190-2.png');
  });

  it('그림을 만들다 실패하면 안내하고 만드는 동안은 다시 누를 수 없다', async () => {
    let fail!: (reason: unknown) => void;
    const download = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    render(
      createElement(TimelapseView, {
        frames: [frame([1])],
        map: [city(1)],
        source: stored({ 1: wei }),
        ...viewProps,
        download,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '이 달 그림 내려받기' }));
    const working = await screen.findByRole('button', { name: '만드는 중' });
    expect((working as HTMLButtonElement).disabled).toBe(true);
    fail(new Error('캔버스 없음'));
    expect(await screen.findByText('그림을 만들지 못했습니다.')).toBeTruthy();
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('X3 프레임에 없는 지도 도시', () => {
  it('점선 빈 원이다', () => {
    const view = okView(frameView(frame([1]), [city(1), city(2)], stored({ 1: wei })));
    const [, missing] = circles(frameDrawing({ worldName: 'w', date: 'd', view }).ops);
    expect(missing).toMatchObject({ kind: 'circle', fill: null, dashed: true });
  });
});

describe('X4 범례', () => {
  it('재생 화면과 같은 순서(많은 순, 같으면 ID 순)이고 공백지가 마지막이다', () => {
    const view = okView(
      frameView(
        frame([3, 2, 3, 1, null]),
        [1, 2, 3, 4, 5].map((k) => city(k)),
        stored({
          1: { name: '위', color: '#000001' },
          2: { name: '촉', color: '#000002' },
          3: { name: '오', color: '#000003' },
        }),
      ),
    );
    const legend = texts(frameDrawing({ worldName: 'w', date: 'd', view }).ops).slice(1, -1);
    expect(legend).toEqual(['오 2', '위 1', '촉 1', '공백지 1']);
  });

  it.each([
    { count: 15, height: 656 },
    { count: 16, height: 676 },
    { count: 19, height: 676 },
    { count: 20, height: 696 },
    { count: 21, height: 696 },
  ])('국가 $count개의 이름·도시 수를 모두 그리고 높이 $height 안에 범례와 꼬리말을 둔다', ({ count, height }) => {
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const view = okView(
      frameView(
        frame(ids),
        ids.map((k) => city(k)),
        stored(Object.fromEntries(ids.map((id) => [id, { name: `국${id}`, color: '#123456' }]))),
      ),
    );
    const drawing = frameDrawing({ worldName: 'w', date: 'd', view });
    expect([drawing.width, drawing.height]).toEqual([700, height]);
    expect(drawing.ops[0]).toEqual({ kind: 'rect', x: 0, y: 0, w: 700, h: height, fill: '#ffffff' });
    expect(texts(drawing.ops).slice(1, -1)).toEqual([...ids.map((id) => `국${id} 1`), '공백지 0']);
    const labels = drawing.ops.filter((op) => op.kind === 'text').slice(1, -1);
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.x + label.maxWidth!).toBeLessThanOrEqual(700);
      expect(label.y + Math.ceil(label.size / 4)).toBeLessThan(height - 24);
    }
    expect(drawing.ops.at(-1)).toMatchObject({ kind: 'text', text: EXPORT_NOTE, y: height - 8 });
  });

  it('내려받기에 마지막 국가까지 담은 그림과 늘어난 높이를 함께 전달한다', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const download = vi.fn<DownloadPng>(() => Promise.resolve());
    render(
      createElement(TimelapseView, {
        frames: [frame(ids)],
        map: ids.map((k) => city(k)),
        source: stored(Object.fromEntries(ids.map((id) => [id, { name: `국${id}`, color: '#123456' }]))),
        ...viewProps,
        download,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '이 달 그림 내려받기' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const drawing = download.mock.calls[0]![0];
    expect([drawing.width, drawing.height]).toEqual([700, 696]);
    expect(texts(drawing.ops).slice(-3)).toEqual(['국20 1', '공백지 0', EXPORT_NOTE]);
  });
});

describe('X5 파일 이름', () => {
  it('쓸 수 없는 글자를 밑줄로 바꾸고 비면 월드로 둔다', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j\nk')).toBe('a_b_c_d_e_f_g_h_i_j_k');
    expect(safeFileName('   ')).toBe('월드');
    expect(safeFileName('..')).toBe('월드');
    expect(pngFileName('삼국 1기', { year: 191, month: 3 })).toBe('opensamguk-삼국 1기-191-3.png');
  });
});

// 공개 조회 응답. 서버가 섞어 보낸 칸(지금 국가 행, 국고, 장수)을 일부러 넣는다.
const leaky = {
  world: { name: '끝난 월드', endedYear: 200, endedMonth: 5, gold: 999 },
  map: {
    cities: [
      { cityKey: 1, name: '낙양', x: 100, y: 50, connections: [2], level: 8, nationId: 1, supplied: true },
      { cityKey: 2, name: '허창', x: 140, y: 80, connections: [1] },
    ],
  },
  items: [
    {
      tick: 10_000,
      year: 190,
      month: 2,
      cities: [
        { cityKey: 1, nationId: 1, population: 5 },
        { cityKey: 2, nationId: null },
      ],
      nations: [{ id: 1, name: '위', color: '#000080', gold: 1 }],
      generals: [{ id: 3, name: '장수' }],
    },
  ],
  currentNations: [{ id: 1, name: '지금위', color: '#ff0000' }],
  nextCursor: null,
} as unknown as PublicFrames;

describe('X6 공유 응답에서 보이는 것만 고른다', () => {
  it('currentNations·국고·장수·도시 수치를 버리고 재생 입력 칸만 남긴다', () => {
    const page = toSharedPage(leaky);
    const head = toSharedHead(leaky);
    const out = JSON.stringify({ page, head });
    for (const word of ['currentNations', 'gold', 'generals', 'population', '지금위', 'level', 'supplied'])
      expect(out).not.toContain(word);
    expect(page.items[0]).toEqual({
      tick: 10_000,
      year: 190,
      month: 2,
      cities: [
        { cityKey: 1, nationId: 1 },
        { cityKey: 2, nationId: null },
      ],
      nations: [{ id: 1, name: '위', color: '#000080' }],
    });
    expect(head.world).toEqual({ name: '끝난 월드', endedYear: 200, endedMonth: 5 });
  });

  it('첫 페이지에 지도가 없으면 그리지 않고 오류로 낸다', () => {
    expect(() => toSharedHead({ ...leaky, map: null })).toThrow('공유 지도를 받지 못했습니다.');
  });
});

const trpcError = (code: string, httpStatus: number) =>
  TRPCClientError.from({ error: { message: code, code: -32000, data: { code, httpStatus } } });
const show = (node: ReactNode) => render(createElement(Fragment, null, node));

describe('X7 공유 화면 거부 안내', () => {
  it('FORBIDDEN은 종료 월드 안내와 로그인 링크, NOT_FOUND는 없는 월드, 그 밖은 다시 시도다', () => {
    const retry = vi.fn();
    const forbidden = show(sharedErrorView(trpcError('FORBIDDEN', 403), retry));
    expect(screen.getByText('종료된 월드만 로그인 없이 볼 수 있습니다.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '로그인' }).getAttribute('href')).toBe('/login');
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    forbidden.unmount();

    const missing = show(sharedErrorView(trpcError('NOT_FOUND', 404), retry));
    expect(screen.getByText('월드를 찾을 수 없습니다.')).toBeTruthy();
    missing.unmount();

    show(sharedErrorView(new Error('연결 끊김'), retry));
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('X8 공유 링크 버튼', () => {
  it('ENDED에서만 그리고 누르면 공유 주소를 복사한다', async () => {
    for (const status of ['PREOPEN', 'RUNNING', 'PAUSED', undefined]) {
      const view = render(createElement(ShareLinkButton, { worldId: 'w1', status }));
      expect(screen.queryByRole('button', { name: '공유 링크 복사' })).toBeNull();
      view.unmount();
    }
    const writeText = vi.fn(() => Promise.resolve());
    render(createElement(ShareLinkButton, { worldId: 'w1', status: 'ENDED', origin: 'https://game.test', writeText }));
    fireEvent.click(screen.getByRole('button', { name: '공유 링크 복사' }));
    expect(await screen.findByText('공유 링크를 복사했습니다. 로그인 없이 볼 수 있습니다.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('https://game.test/share/timelapse/w1');
  });

  it('클립보드를 쓸 수 없으면 주소를 글로 보인다', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('권한 없음')));
    render(createElement(ShareLinkButton, { worldId: 'w2', status: 'ENDED', origin: 'https://game.test', writeText }));
    fireEvent.click(screen.getByRole('button', { name: '공유 링크 복사' }));
    expect((await screen.findByTestId('timelapse-share-url')).textContent).toBe('https://game.test/share/timelapse/w2');
  });
});

describe('X9 공개 지도 다섯 칸만으로 재생과 PNG 입력이 돈다', () => {
  it('공개 지도로 만든 결과가 같은 좌표의 로그인 지도(MapCity) 결과와 같다', () => {
    const map = toSharedMap(leaky.map!.cities);
    for (const entry of map) expect(Object.keys(entry).sort()).toEqual(['key', 'links', 'name', 'x', 'y']);
    const sharedFrame = toSharedFrame(leaky.items[0]!);
    const source = stored({ 1: wei });
    const fromPublic = okView(frameView(sharedFrame, map, source));
    const login: MapCity[] = map.map((entry) => ({ ...entry, level: 3, nationId: 2, supplied: true }));
    const fromLogin = okView(frameView(sharedFrame, login, source));
    const opsPublic = frameDrawing({ worldName: 'w', date: 'd', view: fromPublic });
    const opsLogin = frameDrawing({ worldName: 'w', date: 'd', view: fromLogin });
    expect(opsPublic).toEqual(opsLogin);

    render(createElement(TimelapseView, { frames: [sharedFrame], map, source, ...viewProps }));
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('190년 2월 영토 지도, 도시 2개');
  });
});

describe('X10 채움·단언 없음', () => {
  it('timelapse 소스에 MapCity 단언이나 가짜 규모·보급 채움이 없다', () => {
    const dir = new NodeURL('./', import.meta.url);
    const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
    expect(sources).toEqual(expect.arrayContaining(['sharedSource.ts', 'SharedTimelapsePage.tsx', 'export.ts']));
    for (const name of sources) {
      const text = readFileSync(new NodeURL(name, dir), 'utf8');
      for (const banned of ['as MapCity', 'as unknown as', 'level: 0', 'supplied: false', 'nationId: null,'])
        expect(`${name}: ${text.includes(banned)}`).toBe(`${name}: false`);
    }
  });
});
