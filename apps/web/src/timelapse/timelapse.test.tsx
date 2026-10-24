// @vitest-environment jsdom
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapCity } from '../game/types';
import { savedNationSource, savedNationSource as storedNationSource, type SavedFrame } from './displaySource';
import {
  frameView,
  joinPages,
  type FrameNation,
  type NationDisplaySource,
  type StoredNation,
  type TimelapseFrame,
  type TimelapsePage,
} from './frames';
import { useTimelapsePages, type FetchTimelapsePage, type TimelapseInput } from './pages';
import { initialPlayback, isWaiting, playback } from './playback';
import { TimelapseScreen, type TimelapseMap } from './TimelapsePanel';
import { TimelapseView } from './TimelapseView';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const city = (key: number, links: number[] = []): MapCity => ({
  key,
  name: `도시${key}`,
  level: 5,
  x: key * 10,
  y: key * 10,
  nationId: null,
  supplied: true,
  links,
});

const frame = (i: number, owners: Array<number | null>): TimelapseFrame & SavedFrame => ({
  tick: (i + 1) * 10_000,
  year: 190 + Math.floor(i / 12),
  month: (i % 12) + 1,
  cities: owners.map((nationId, k) => ({ cityKey: k + 1, nationId })),
  nations: [],
});

// 시험용 출처. 프레임 tick마다 그때 저장된 국가 값을 둔다. 없는 국가는 missing이다.
function storedSource(byTick: Record<number, Record<number, { name: string; color: string }>>): NationDisplaySource {
  return {
    resolve(tick, nationId): FrameNation {
      if (nationId === null) return { kind: 'empty' };
      const stored = byTick[tick]?.[nationId];
      return stored ? { kind: 'stored', id: nationId, ...stored } : { kind: 'missing', id: nationId };
    },
  };
}

// 저장된 프레임을 T4-35 계약대로 오래된 달부터 30개씩 내 준다.
function pagesOf(frames: readonly TimelapseFrame[], cursor?: string): TimelapsePage {
  const after = cursor === undefined ? -1 : Number(cursor);
  const rest = frames.filter((f) => f.tick > after);
  const items = rest.slice(0, 30);
  const last = items.at(-1);
  return { items, nextCursor: rest.length > 30 && last ? String(last.tick) : null };
}

const viewProps = { hasMore: false, nextError: false, onRetryNext: () => {}, contractError: null } as const;

describe('U1 페이지 잇기', () => {
  const frames = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
  const first = pagesOf(frames);
  const second = pagesOf(frames, first.nextCursor ?? undefined);

  it('두 페이지를 tick 오름차순 35개로 잇는다', () => {
    const joined = joinPages([first, second]);
    expect(joined.ok).toBe(true);
    expect(joined.frames.map((f) => f.tick)).toEqual(frames.map((f) => f.tick));
  });

  it('같은 tick 반복과 역순은 정렬해서 덮지 않고 오류로 낸다', () => {
    const repeated = { ...second, items: [first.items.at(-1)!, ...second.items] };
    expect(joinPages([first, repeated])).toMatchObject({ ok: false, error: 'order' });
    const reversed = { items: [...first.items].reverse(), nextCursor: null };
    expect(joinPages([reversed])).toMatchObject({ ok: false, error: 'order' });
  });

  it('nextCursor가 그 페이지 마지막 tick과 다르면 오류다', () => {
    const wrong = { ...first, nextCursor: String(first.items[0]!.tick) };
    const joined = joinPages([wrong, second]);
    expect(joined).toMatchObject({ ok: false, error: 'cursor' });
    expect(joined.frames).toHaveLength(30);
  });
});

describe('U2 표시값 출처', () => {
  const map = [city(1), city(2)];
  const frames = [frame(0, [1, 2]), frame(1, [1, 1])];
  const source = storedSource({
    10_000: { 1: { name: '옛한', color: '#112233' }, 2: { name: '사라진나라', color: '#445566' } },
    20_000: { 1: { name: '새한', color: '#778899' } },
  });
  // 지금 국가 행 값. 화면은 어디에도 쓰지 않아야 한다.
  const currentNations = [{ id: 1, name: '지금이름', color: '#ff0000' }];

  it('프레임마다 그 프레임에 저장된 이름과 색으로 그린다', () => {
    render(<TimelapseView frames={frames} map={map} source={source} {...viewProps} />);
    const dot = (key: number) => document.querySelector(`[data-city-key="${key}"] circle`) as SVGCircleElement;
    expect(dot(1).style.fill).toBe('rgb(17, 34, 51)');
    expect(dot(2).style.fill).toBe('rgb(68, 85, 102)');
    expect(screen.getByLabelText('이 달의 국가별 도시 수').textContent).toContain('사라진나라 1');

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(dot(1).style.fill).toBe('rgb(119, 136, 153)');
    expect(screen.getByLabelText('이 달의 국가별 도시 수').textContent).toContain('새한 2');
    expect(document.body.textContent).not.toContain(currentNations[0]!.name);
    expect(document.body.innerHTML).not.toContain('255, 0, 0');
  });

  it('응답 출처는 그 프레임의 nations만 읽고 다른 달 값이나 빠진 국가를 메우지 않는다', () => {
    const answered = [
      { ...frame(0, [1, 2]), nations: [{ id: 1, name: '옛한', color: '#112233' }] },
      { ...frame(1, [1, 1]), nations: [{ id: 1, name: '새한', color: '#778899' }] },
    ];
    const fromResponse = storedNationSource(answered);
    expect(fromResponse.resolve(10_000, 1)).toEqual({ kind: 'stored', id: 1, name: '옛한', color: '#112233' });
    expect(fromResponse.resolve(20_000, 1)).toEqual({ kind: 'stored', id: 1, name: '새한', color: '#778899' });
    expect(fromResponse.resolve(10_000, 2)).toEqual({ kind: 'missing', id: 2 });
    expect(fromResponse.resolve(30_000, 1)).toEqual({ kind: 'missing', id: 1 });
    expect(fromResponse.resolve(10_000, null)).toEqual({ kind: 'empty' });
  });
});

describe('U3 기록 없는 프레임', () => {
  const map = [city(1), city(2)];
  const frames = [frame(0, [1, null]), frame(1, [1, 2]), frame(2, [1, 1])];
  const source = storedSource({
    10_000: { 1: { name: '위', color: '#000080' } },
    20_000: { 1: { name: '위', color: '#000080' } },
    30_000: { 1: { name: '위', color: '#000080' } },
  });

  it('저장값 없는 소유 국가가 있으면 그 프레임만 지도 대신 사실을 보이고 다른 달은 그린다', () => {
    render(<TimelapseView frames={frames} map={map} source={source} {...viewProps} />);
    expect(screen.getByRole('img')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByText('이 시점의 국가 기록이 없습니다.')).toBeTruthy();
    expect(screen.getByText('다른 달을 골라 주세요.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByLabelText('이 달의 국가별 도시 수')).toBeNull();
    expect(document.querySelector('circle')).toBeNull();
    expect(document.body.textContent).not.toContain('도시1');
    expect(screen.getByTestId('timelapse-date').textContent).toBe('190년 2월 (2/3) 국가 기록 없음');

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByRole('img')).toBeTruthy();
    expect(screen.queryByText('이 시점의 국가 기록이 없습니다.')).toBeNull();
  });

  it('재생도 기록 없는 달을 지나 다음 달로 간다', () => {
    vi.useFakeTimers();
    render(<TimelapseView frames={frames} map={map} source={source} {...viewProps} />);
    fireEvent.click(screen.getByRole('button', { name: '재생' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('이 시점의 국가 기록이 없습니다.')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('img')).toBeTruthy();
  });
});

describe('U4 지도와 프레임 잇기', () => {
  it('프레임에 없는 지도 도시는 기록 없음, 지도에 없는 프레임 도시는 개수만 센다', () => {
    const source = storedSource({ 10_000: { 1: { name: '위', color: '#000080' } } });
    const odd: TimelapseFrame = {
      ...frame(0, []),
      cities: [
        { cityKey: 1, nationId: 1 },
        { cityKey: 2, nationId: null },
        { cityKey: 99, nationId: null },
      ],
    };
    const view = frameView(odd, [city(1), city(2), city(3)], source);
    expect(view).toMatchObject({ kind: 'ok', offMap: 1, empty: 1 });

    render(<TimelapseView frames={[odd]} map={[city(1), city(2), city(3)]} source={source} {...viewProps} />);
    const third = document.querySelector('[data-city-key="3"]')!;
    expect(third.getAttribute('data-recorded')).toBe('false');
    expect(third.querySelector('title')?.textContent).toBe('도시3, 기록 없음');
    expect(screen.getByText('지도에 없는 도시 1곳')).toBeTruthy();
  });
});

describe('U5 범례', () => {
  it('도시 수 많은 순, 같으면 id 순이다', () => {
    const named = { name: '', color: '#000000' };
    const source = storedSource({
      10_000: { 3: { ...named, name: '오' }, 2: { ...named, name: '촉' }, 1: { ...named, name: '위' } },
    });
    const view = frameView(
      frame(0, [3, 2, 3, 1, null]),
      [1, 2, 3, 4, 5].map((k) => city(k)),
      source,
    );
    if (view.kind !== 'ok') throw new Error('지도가 있어야 한다');
    expect(view.legend.map((x) => `${x.nation.name}${x.count}`)).toEqual(['오2', '위1', '촉1']);
  });
});

describe('U6 재생 reducer', () => {
  it('처음 0, 경계에서 멈추고 조작하면 정지한다', () => {
    expect(initialPlayback).toEqual({ index: 0, playing: false });
    expect(playback(initialPlayback, { type: 'prev' }).index).toBe(0);
    const playing = { index: 2, playing: true };
    expect(playback(playing, { type: 'next', count: 3 })).toEqual({ index: 2, playing: false });
    expect(playback(playing, { type: 'prev' })).toEqual({ index: 1, playing: false });
    expect(playback(playing, { type: 'seek', index: 9, count: 3 })).toEqual({ index: 2, playing: false });
    expect(playback(playing, { type: 'first' })).toEqual({ index: 0, playing: false });
  });

  it('끝에서 더 받을 것이 있으면 기다리고 없으면 정지한다', () => {
    const atEnd = { index: 2, playing: true };
    expect(playback({ index: 1, playing: true }, { type: 'tick', count: 3, hasMore: false }).index).toBe(2);
    expect(playback(atEnd, { type: 'tick', count: 3, hasMore: true })).toEqual(atEnd);
    expect(isWaiting(atEnd, 3, true)).toBe(true);
    expect(playback(atEnd, { type: 'tick', count: 3, hasMore: false })).toEqual({ index: 2, playing: false });
    expect(playback(atEnd, { type: 'tick', count: 4, hasMore: false }).index).toBe(3);
  });

  it('끝에서 재생하면 처음부터 한다', () => {
    expect(playback({ index: 2, playing: false }, { type: 'toggle', count: 3, hasMore: false })).toEqual({
      index: 0,
      playing: true,
    });
    expect(playback({ index: 2, playing: false }, { type: 'toggle', count: 3, hasMore: true })).toEqual({
      index: 2,
      playing: true,
    });
  });
});

describe('U7 화면 재생', () => {
  const frames = [frame(0, [null]), frame(1, [null]), frame(2, [null])];
  const source = storedSource({});

  it('1초마다 한 달씩 가고 정지하면 그대로다. 재생 중에는 날짜를 읽어 주지 않는다', () => {
    vi.useFakeTimers();
    render(<TimelapseView frames={frames} map={[city(1)]} source={source} {...viewProps} />);
    const date = screen.getByTestId('timelapse-date');
    expect(date.textContent).toBe('190년 1월 (1/3)');
    expect(date.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('190년 1월 영토 지도, 도시 1개');

    fireEvent.click(screen.getByRole('button', { name: '재생' }));
    expect(date.getAttribute('aria-live')).toBe('off');
    act(() => vi.advanceTimersByTime(1000));
    expect(date.textContent).toBe('190년 2월 (2/3)');
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('190년 2월 영토 지도, 도시 1개');

    fireEvent.click(screen.getByRole('button', { name: '정지' }));
    expect(date.getAttribute('aria-live')).toBe('polite');
    act(() => vi.advanceTimersByTime(3000));
    expect(date.textContent).toBe('190년 2월 (2/3)');
  });

  it('받은 끝에서 더 받을 것이 있으면 기다림을 보인다', () => {
    vi.useFakeTimers();
    render(<TimelapseView frames={frames.slice(0, 1)} map={[city(1)]} source={source} {...viewProps} hasMore />);
    fireEvent.click(screen.getByRole('button', { name: '재생' }));
    expect(screen.getByText('다음 기록을 불러오는 중')).toBeTruthy();
  });

  it('프레임이 없으면 빈 상태다', () => {
    render(<TimelapseView frames={[]} map={[city(1)]} source={source} {...viewProps} />);
    expect(screen.getByText('영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다')).toBeTruthy();
  });

  it('빈 첫 페이지에 nextCursor가 있으면 빈 상태가 아니라 계약 오류다', () => {
    const joined = joinPages([{ items: [], nextCursor: '10000' }]);
    expect(joined).toMatchObject({ ok: false, error: 'cursor', frames: [] });
    render(
      <TimelapseView
        frames={joined.frames}
        map={[city(1)]}
        source={source}
        {...viewProps}
        contractError={joined.ok ? null : joined.error}
      />,
    );
    expect(screen.getByText('기록 순서가 맞지 않아 더 불러오지 않았습니다.')).toBeTruthy();
    expect(screen.queryByText('영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다')).toBeNull();
  });
});

describe('U8 사건을 지어내지 않음', () => {
  it('소유가 바뀌는 두 달을 그려도 사건 문구나 국력 수치가 없다', () => {
    const source = storedSource({
      10_000: { 1: { name: '위', color: '#000080' }, 2: { name: '촉', color: '#008000' } },
      20_000: { 1: { name: '위', color: '#000080' } },
    });
    render(
      <TimelapseView
        frames={[frame(0, [1, 2]), frame(1, [1, 1])]}
        map={[city(1), city(2)]}
        source={source}
        {...viewProps}
      />,
    );
    const texts = [document.body.textContent];
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    texts.push(document.body.textContent);
    for (const text of texts)
      for (const word of ['건국', '전투', '점령', '함락', '멸망했', '국력', '국고', '군량'])
        expect(text).not.toContain(word);
  });
});

describe('U9 언마운트', () => {
  it('재생 중 언마운트하면 타이머가 남지 않는다', () => {
    vi.useFakeTimers();
    const view = render(
      <TimelapseView
        frames={[frame(0, [null]), frame(1, [null])]}
        map={[city(1)]}
        source={storedSource({})}
        {...viewProps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '재생' }));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('U10·U11 캐시 정책', () => {
  const queryKey = ['timelapse', 'frames', 'w1', 'pages'];
  const otherKey = ['records', 'world', 'w1', 'pages'];

  function Harness({ fetchPage }: { fetchPage: FetchTimelapsePage }) {
    const { frames, hasMore } = useTimelapsePages('w1', fetchPage, queryKey, false);
    return (
      <p data-testid="loaded">
        {frames.length}
        {hasMore ? '+' : ''}
      </p>
    );
  }

  function setup(fetchPage: FetchTimelapsePage) {
    const client = new QueryClient();
    client.setQueryData(otherKey, 'records');
    const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <Harness fetchPage={fetchPage} />
        </QueryClientProvider>,
      );
    return { client, mount };
  }

  it('보는 동안 다시 받지 않고 떼면 캐시를 지우며 다시 붙이면 첫 페이지부터 받아 새 달이 나온다', async () => {
    const stored = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
    const calls: TimelapseInput[] = [];
    const fetchPage: FetchTimelapsePage = (input) => {
      calls.push(input);
      return Promise.resolve(pagesOf(stored, 'cursor' in input ? input.cursor : undefined));
    };
    const { client, mount } = setup(fetchPage);

    const first = mount();
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('35'));
    expect(calls).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => Promise.resolve());
    expect(calls).toHaveLength(2);

    first.unmount();
    await waitFor(() => expect(client.getQueryCache().find({ queryKey })).toBeUndefined());
    expect(client.getQueryData(otherKey)).toBe('records');

    stored.push(frame(35, [null]));
    mount();
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('36'));
    expect(calls.slice(2)).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);
    expect(client.getQueryData(otherKey)).toBe('records');
  });

  it('둘째 페이지를 받는 중에 떼면 그 요청이 끊긴다', async () => {
    const stored = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
    const signals: AbortSignal[] = [];
    const fetchPage: FetchTimelapsePage = (input, { signal }) => {
      signals.push(signal);
      if (!('cursor' in input)) return Promise.resolve(pagesOf(stored));
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    const { mount } = setup(fetchPage);

    const view = mount();
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(screen.getByTestId('loaded').textContent).toBe('30+');
    view.unmount();
    expect(signals[1]!.aborted).toBe(true);
  });
});

// 아래는 조회 연결 뒤의 시험이다. 프레임마다 그 tick의 저장 국가(nations)를 서버 응답처럼 둔다.
type Saved = TimelapseFrame & SavedFrame;
const saved = (i: number, owners: Array<number | null>, nations: StoredNation[]): Saved => ({
  ...frame(i, owners),
  nations,
});

// 서버 응답 모양. currentNations는 지금 국가 행 값이라 화면은 읽지 않아야 한다.
type ServerPage = TimelapsePage<Saved> & { currentNations: StoredNation[] };
function savedPageOf(frames: readonly Saved[], cursor?: string, currentNations: StoredNation[] = []): ServerPage {
  const after = cursor === undefined ? -1 : Number(cursor);
  const rest = frames.filter((f) => f.tick > after);
  const items = rest.slice(0, 30);
  const last = items.at(-1);
  return { items, currentNations, nextCursor: rest.length > 30 && last ? String(last.tick) : null };
}
const cursorOf = (input: TimelapseInput) => ('cursor' in input ? input.cursor : undefined);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 첫 렌더가 부하에 밀린 기록이 있어(구현 기록) 연결 시험은 기다림을 넉넉히 둔다.
const wait = { timeout: 5_000 };
const SLOW = 15_000;
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('U12 저장값 출처 (savedNationSource)', () => {
  const frames: Saved[] = [
    saved(
      0,
      [1, 2],
      [
        { id: 1, name: '옛위', color: '#112233' },
        { id: 2, name: '촉', color: '#008000' },
      ],
    ),
    saved(1, [1, 2], [{ id: 1, name: '새위', color: '#445566' }]),
    saved(
      2,
      [1],
      [
        { id: 1, name: '위', color: '#000080' },
        { id: 1, name: '두번째위', color: '#000000' },
      ],
    ),
  ];
  // 같은 응답의 지금 국가 행 값. 출처에는 넣을 자리가 없고 어느 결과에도 나오면 안 된다.
  const currentNations: StoredNation[] = [
    { id: 1, name: '지금위', color: '#ff0000' },
    { id: 2, name: '지금촉', color: '#00ff00' },
  ];
  const source = savedNationSource(frames);

  it('프레임마다 그 프레임 nations의 이름과 색을 그대로 쓴다', () => {
    expect(source.resolve(10_000, 1)).toEqual({ kind: 'stored', id: 1, name: '옛위', color: '#112233' });
    expect(source.resolve(20_000, 1)).toEqual({ kind: 'stored', id: 1, name: '새위', color: '#445566' });
    expect(source.resolve(10_000, 2)).toEqual({ kind: 'stored', id: 2, name: '촉', color: '#008000' });
  });

  it('그 프레임에 없는 id는 다른 프레임에 있어도 missing이고 같은 id가 두 번이면 missing이다', () => {
    expect(source.resolve(20_000, 2)).toEqual({ kind: 'missing', id: 2 });
    expect(source.resolve(30_000, 1)).toEqual({ kind: 'missing', id: 1 });
    expect(frameView(frames[1]!, [city(1), city(2)], source)).toEqual({ kind: 'missing', nationIds: [2] });
    expect(frameView(frames[2]!, [city(1)], source)).toEqual({ kind: 'missing', nationIds: [1] });
  });

  it('받지 않은 tick은 missing, null은 empty이고 지금 국가 행 값은 어디에도 나오지 않는다', () => {
    expect(source.resolve(40_000, 1)).toEqual({ kind: 'missing', id: 1 });
    expect(source.resolve(10_000, null)).toEqual({ kind: 'empty' });
    const results = JSON.stringify(
      [10_000, 20_000, 30_000, 40_000].flatMap((tick) => [1, 2, null].map((id) => source.resolve(tick, id))),
    );
    for (const nation of currentNations) {
      expect(results).not.toContain(nation.name);
      expect(results).not.toContain(nation.color);
    }
  });
});

describe('U13 전체 무효화 (실제 QueryClient)', () => {
  const queryKey = ['timelapse', 'frames', 'w1', 'pages'];

  function Harness({ fetchPage }: { fetchPage: FetchTimelapsePage }) {
    const { frames, hasMore } = useTimelapsePages('w1', fetchPage, queryKey, false);
    return (
      <p data-testid="loaded">
        {frames.length}
        {hasMore ? '+' : ''}
      </p>
    );
  }

  function setup(fetchPage: FetchTimelapsePage) {
    const client = new QueryClient();
    const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <Harness fetchPage={fetchPage} />
        </QueryClientProvider>,
      );
    return { client, mount };
  }
  const loaded = () => screen.getByTestId('loaded').textContent;

  it(
    '다 받은 뒤 invalidateQueries()를 불러도 다시 받지 않고 떼고 다시 붙이면 첫 페이지부터 받는다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
      const calls: TimelapseInput[] = [];
      const fetchPage: FetchTimelapsePage = (input) => {
        calls.push(input);
        return Promise.resolve(pagesOf(stored, cursorOf(input)));
      };
      const { client, mount } = setup(fetchPage);

      const view = mount();
      await waitFor(() => expect(loaded()).toBe('35'), wait);
      expect(calls).toHaveLength(2);
      act(() => void client.invalidateQueries());
      await flush();
      act(() => void client.invalidateQueries());
      await flush();
      expect(calls).toHaveLength(2);
      expect(loaded()).toBe('35');

      view.unmount();
      await waitFor(() => expect(client.getQueryCache().find({ queryKey })).toBeUndefined(), wait);
      stored.push(frame(35, [null]));
      mount();
      await waitFor(() => expect(loaded()).toBe('36'), wait);
      expect(calls.slice(2)).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);
    },
    SLOW,
  );

  it(
    '둘째 페이지를 받는 중에 무효화해도 그 요청이 끊기지 않고 첫 페이지를 다시 받지 않는다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
      const calls: TimelapseInput[] = [];
      const signals: AbortSignal[] = [];
      const second = deferred<TimelapsePage>();
      const fetchPage: FetchTimelapsePage = (input, { signal }) => {
        calls.push(input);
        signals.push(signal);
        return 'cursor' in input ? second.promise : Promise.resolve(pagesOf(stored));
      };
      const { client, mount } = setup(fetchPage);

      mount();
      await waitFor(() => expect(calls).toHaveLength(2), wait);
      expect(loaded()).toBe('30+');
      act(() => void client.invalidateQueries());
      await flush();
      expect(signals[1]!.aborted).toBe(false);
      expect(calls).toHaveLength(2);

      second.resolve(pagesOf(stored, '300000'));
      await waitFor(() => expect(loaded()).toBe('35'), wait);
      expect(calls).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);
    },
    SLOW,
  );

  it(
    '첫 페이지를 기다리는 중에 무효화하면 진행 중 요청에 합쳐져 첫 페이지 요청은 하나뿐이다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => frame(i, [null]));
      const calls: TimelapseInput[] = [];
      const first = deferred<TimelapsePage>();
      const fetchPage: FetchTimelapsePage = (input) => {
        calls.push(input);
        return 'cursor' in input ? Promise.resolve(pagesOf(stored, input.cursor)) : first.promise;
      };
      const { client, mount } = setup(fetchPage);

      const view = mount();
      await waitFor(() => expect(calls).toHaveLength(1), wait);
      act(() => void client.invalidateQueries());
      await flush();
      expect(calls).toHaveLength(1);

      first.resolve(pagesOf(stored));
      await waitFor(() => expect(loaded()).toBe('35'), wait);
      expect(calls).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);

      // 무효화가 있었어도 떼고 다시 붙이면 캐시가 없어 첫 페이지부터 받는다 (U10 그대로).
      view.unmount();
      await waitFor(() => expect(client.getQueryCache().find({ queryKey })).toBeUndefined(), wait);
      mount();
      await waitFor(() => expect(loaded()).toBe('35'), wait);
      expect(calls.slice(2)).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);
    },
    SLOW,
  );
});

describe('U14 TimelapseScreen 상태 (실제 QueryClient, 주입한 fetchPage와 지도)', () => {
  const queryKey = ['timelapse', 'frames', 'w1', 'pages'];
  const map = [city(1, [2]), city(2, [1])];
  const ready: TimelapseMap = { data: { cities: map }, isError: false, error: null, refetch: () => undefined };
  const pending: TimelapseMap = { data: undefined, isError: false, error: null, refetch: () => undefined };
  const wei = { id: 1, name: '위', color: '#000080' };
  const three = [saved(0, [1, null], [wei]), saved(1, [1, 1], [wei]), saved(2, [1, null], [wei])];
  const notFound = TRPCClientError.from({
    error: { message: 'NOT_FOUND', code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } },
  });

  function show(fetchPage: FetchTimelapsePage<Saved>, mapState: TimelapseMap = ready) {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <TimelapseScreen worldId="w1" fetchPage={fetchPage} queryKey={queryKey} map={mapState} retry={false} />
      </QueryClientProvider>,
    );
    return { client, view };
  }
  const dateLine = () => screen.getByTestId('timelapse-date').textContent;

  it(
    '첫 페이지 대기와 지도 대기는 role="status"다',
    async () => {
      const first = show(() => new Promise<ServerPage>(() => undefined));
      expect(screen.getByRole('status').textContent).toBe('불러오는 중');
      first.view.unmount();

      const { client } = show(() => Promise.resolve(savedPageOf(three)), pending);
      await waitFor(() => expect(client.getQueryData(queryKey)).toBeDefined(), wait);
      expect(screen.getByRole('status').textContent).toBe('불러오는 중');
      expect(document.querySelector('svg')).toBeNull();
    },
    SLOW,
  );

  it(
    '첫 페이지 NOT_FOUND는 월드를 찾을 수 없습니다이고 다시 시도가 없다',
    async () => {
      show(() => Promise.reject(notFound));
      expect(await screen.findByText('월드를 찾을 수 없습니다', undefined, wait)).toBeTruthy();
      expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
    SLOW,
  );

  it(
    '그 밖의 첫 페이지 오류는 다시 시도이고 누르면 같은 입력으로 다시 받아 첫 달을 그린다',
    async () => {
      const calls: TimelapseInput[] = [];
      let fail = true;
      show((input) => {
        calls.push(input);
        if (fail) return Promise.reject(new Error('연결 끊김'));
        return Promise.resolve(savedPageOf(three, cursorOf(input)));
      });
      const alert = await screen.findByRole('alert', undefined, wait);
      expect(alert.textContent).toContain('불러오지 못했습니다');
      fail = false;
      fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
      expect(await screen.findByRole('img', undefined, wait)).toBeTruthy();
      expect(dateLine()).toBe('190년 1월 (1/3)');
      expect(calls).toEqual([{ worldId: 'w1' }, { worldId: 'w1' }]);
    },
    SLOW,
  );

  it(
    '빈 응답은 빈 상태 문구다',
    async () => {
      show(() => Promise.resolve(savedPageOf([])));
      const empty = await screen.findByText('영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다', undefined, wait);
      expect(empty.closest('[data-state="empty"]')).toBeTruthy();
      expect(document.querySelector('svg')).toBeNull();
    },
    SLOW,
  );

  it(
    '35개 두 페이지는 첫 페이지와 cursor 300000으로 정확히 두 번 받는다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => saved(i, [1, null], [wei]));
      const calls: TimelapseInput[] = [];
      show((input) => {
        calls.push(input);
        return Promise.resolve(savedPageOf(stored, cursorOf(input)));
      });
      expect(await screen.findByText('35개월 불러옴', undefined, wait)).toBeTruthy();
      await flush();
      expect(calls).toEqual([{ worldId: 'w1' }, { worldId: 'w1', cursor: '300000' }]);
      expect(dateLine()).toBe('190년 1월 (1/35)');
    },
    SLOW,
  );

  it(
    '둘째 페이지 오류는 받은 30개월을 그대로 두고 다시 시도 뒤 35개월이 된다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => saved(i, [1, null], [wei]));
      let fail = true;
      show((input) => {
        if ('cursor' in input && fail) return Promise.reject(new Error('연결 끊김'));
        return Promise.resolve(savedPageOf(stored, cursorOf(input)));
      });
      const nextError = () => screen.queryByText('다음 기록을 불러오지 못했습니다.');
      await waitFor(() => expect(nextError()).toBeTruthy(), wait);
      expect(screen.getByText('30개월 불러옴')).toBeTruthy();
      expect(screen.getByRole('img')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '다음' }));
      expect(dateLine()).toBe('190년 2월 (2/30)');
      fail = false;
      fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
      expect(await screen.findByText('35개월 불러옴', undefined, wait)).toBeTruthy();
      await waitFor(() => expect(nextError()).toBeNull(), wait);
    },
    SLOW,
  );

  it(
    '지도 조회 오류는 QueryError이고 좌표 없이 프레임만 그리지 않는다',
    async () => {
      const refetch = vi.fn();
      const { client } = show(() => Promise.resolve(savedPageOf(three)), {
        data: undefined,
        isError: true,
        error: new Error('연결 끊김'),
        refetch,
      });
      await waitFor(() => expect(client.getQueryData(queryKey)).toBeDefined(), wait);
      expect((await screen.findByRole('alert', undefined, wait)).textContent).toContain('불러오지 못했습니다');
      expect(document.querySelector('svg')).toBeNull();
      expect(screen.queryByTestId('timelapse-date')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
      expect(refetch).toHaveBeenCalledTimes(1);
    },
    SLOW,
  );

  it(
    '프레임 nations에 없고 currentNations에만 있는 국가는 그 프레임을 기록 없음으로 막고 이름을 어디에도 쓰지 않는다',
    async () => {
      const frames = [saved(0, [1, 2], [wei]), saved(1, [1, 1], [wei])];
      const current = [wei, { id: 2, name: '지금만있는나라', color: '#00ff00' }];
      show((input) => Promise.resolve(savedPageOf(frames, cursorOf(input), current)));
      expect(await screen.findByText('이 시점의 국가 기록이 없습니다.', undefined, wait)).toBeTruthy();
      expect(dateLine()).toBe('190년 1월 (1/2) 국가 기록 없음');
      expect(document.querySelector('svg')).toBeNull();
      expect(document.body.textContent).not.toContain('지금만있는나라');

      fireEvent.click(screen.getByRole('button', { name: '다음' }));
      expect(screen.getByRole('img')).toBeTruthy();
      expect(document.body.textContent).not.toContain('지금만있는나라');
      expect(document.body.innerHTML).not.toContain('0, 255, 0');
    },
    SLOW,
  );

  it(
    '국가 1의 지금 값과 저장값이 다르면 도시 title·범례·점 채움은 저장값이다',
    async () => {
      const frames = [saved(0, [1, null], [{ id: 1, name: '옛위', color: '#112233' }])];
      const current = [{ id: 1, name: '지금위', color: '#ff0000' }];
      show((input) => Promise.resolve(savedPageOf(frames, cursorOf(input), current)));
      await screen.findByRole('img', undefined, wait);
      const first = document.querySelector('[data-city-key="1"]')!;
      expect(first.getAttribute('data-nation-id')).toBe('1');
      expect(first.querySelector('title')?.textContent).toBe('도시1, 옛위');
      expect((first.querySelector('circle') as SVGCircleElement).style.fill).toBe('rgb(17, 34, 51)');
      expect(screen.getByLabelText('이 달의 국가별 도시 수').textContent).toContain('옛위 1');
      expect(document.body.textContent).not.toContain('지금위');
      expect(document.body.innerHTML).not.toContain('255, 0, 0');
    },
    SLOW,
  );

  it(
    '둘째 페이지를 받는 중에 언마운트하면 그 요청의 signal이 끊긴다',
    async () => {
      const stored = Array.from({ length: 35 }, (_, i) => saved(i, [1, null], [wei]));
      const signals: AbortSignal[] = [];
      const { view } = show((input, { signal }) => {
        signals.push(signal);
        if (!('cursor' in input)) return Promise.resolve(savedPageOf(stored));
        return new Promise<ServerPage>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      });
      await waitFor(() => expect(signals).toHaveLength(2), wait);
      expect(screen.getByText('30개월 불러옴')).toBeTruthy();
      view.unmount();
      expect(signals[1]!.aborted).toBe(true);
    },
    SLOW,
  );
});
