// @vitest-environment jsdom
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapCity } from '../game/types';
import {
  frameView,
  joinPages,
  type FrameNation,
  type NationDisplaySource,
  type TimelapseFrame,
  type TimelapsePage,
} from './frames';
import { storedNationSource } from './displaySource';
import { useTimelapsePages, type FetchTimelapsePage, type TimelapseInput } from './pages';
import { initialPlayback, isWaiting, playback } from './playback';
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

const frame = (i: number, owners: Array<number | null>): TimelapseFrame => ({
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
