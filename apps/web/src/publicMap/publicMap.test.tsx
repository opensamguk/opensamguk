// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PublicMapView } from './PublicMapTabs';
import { snapshotTimeText, toPublicMaps, type PublicMaps } from './publicMaps';

afterEach(cleanup);

// T2-25 · AC-M2-20: 공개 지도 탭, 키보드, 빈 상태, 공개 범위.
const now = new Date(2026, 9, 23, 14, 25);
const takenAt = (hour: number, minute: number) => new Date(2026, 9, 23, hour, minute).toISOString();

const city = (key: number, nationId: number | null, links: number[] = []) => ({
  key,
  name: `도시${key}`,
  level: 5,
  x: key * 10,
  y: key * 10,
  nationId,
  links,
});

const data: PublicMaps = {
  delayMinutes: 10,
  worlds: [
    {
      id: 'w1',
      name: '첫 천하',
      status: 'RUNNING',
      map: {
        takenAt: takenAt(14, 10),
        year: 190,
        month: 3,
        cities: [city(1, 1, [2]), city(2, null, [1])],
        nations: [{ id: 1, name: '위', color: '#000080' }],
      },
    },
    {
      id: 'w2',
      name: '둘째 천하',
      status: 'PAUSED',
      map: {
        takenAt: takenAt(9, 0),
        year: 201,
        month: 11,
        cities: [city(1, 2), city(2, 2)],
        nations: [{ id: 2, name: '오', color: '#ff0000' }],
      },
    },
    { id: 'w3', name: '셋째 천하', status: 'RUNNING', map: null },
  ],
};

const tabs = () => screen.getAllByRole('tab');
const selectedName = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;

describe('공개 지도 탭', () => {
  it('처음에는 첫 월드를 열고 탭을 누르면 지도 하나와 기준 시각 줄이 그 월드로 바뀐다', () => {
    render(<PublicMapView data={data} now={now} />);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('진행 중인 월드');
    expect(tabs().map((tab) => tab.textContent)).toEqual(['첫 천하', '둘째 천하멈춤', '셋째 천하']);
    expect(selectedName()).toBe('첫 천하');
    expect(screen.getAllByTestId('world-map')).toHaveLength(1);
    expect(screen.getByTestId('public-map-when').textContent).toBe(
      '190년 3월 · 오후 2시 10분 기준10분 이상 지난 상태입니다',
    );
    expect(screen.getByRole('img', { name: '도시1, 위' })).toBeTruthy();

    fireEvent.click(tabs()[1]!);
    expect(selectedName()).toBe('둘째 천하멈춤');
    expect(screen.getAllByTestId('world-map')).toHaveLength(1);
    expect(screen.getByRole('tabpanel').getAttribute('data-world-id')).toBe('w2');
    expect(screen.getByTestId('public-map-when').textContent).toContain('201년 11월 · 오전 9시 기준');
    expect(screen.getByRole('img', { name: '도시1, 오' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: '도시1, 위' })).toBeNull();
  });

  it('국가 이름과 색 견본을 범례에 두고 내 위치·보급 끊김 항목은 없다', () => {
    render(<PublicMapView data={data} now={now} />);
    const legend = screen.getByLabelText('지도 범례');
    expect(legend.textContent).toBe('공백지 1위 1');
    expect(within(legend).queryByText(/내 위치|보급 끊김/)).toBeNull();
  });

  it('도시는 누를 수 없고 초점을 받지 않는다', () => {
    render(<PublicMapView data={data} now={now} />);
    const map = screen.getByTestId('world-map');
    expect(within(map).queryAllByRole('button')).toHaveLength(0);
    expect(map.querySelector('[tabindex]')).toBeNull();
  });

  it('왼쪽·오른쪽 방향키로 탭을 옮기고 끝에서 반대쪽으로 돈다. Home과 End도 쓴다', () => {
    render(<PublicMapView data={data} now={now} />);
    const [first, second, third] = tabs();
    expect(first!.tabIndex).toBe(0);
    expect(second!.tabIndex).toBe(-1);

    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowRight' });
    expect(selectedName()).toBe('둘째 천하멈춤');
    expect(document.activeElement).toBe(second);
    expect(second!.tabIndex).toBe(0);

    fireEvent.keyDown(second!, { key: 'ArrowLeft' });
    fireEvent.keyDown(first!, { key: 'ArrowLeft' });
    expect(selectedName()).toBe('셋째 천하');
    expect(document.activeElement).toBe(third);

    fireEvent.keyDown(third!, { key: 'Home' });
    expect(selectedName()).toBe('첫 천하');
    fireEvent.keyDown(first!, { key: 'End' });
    expect(selectedName()).toBe('셋째 천하');
  });
});

describe('공개 지도 빈 상태', () => {
  it('사본이 없는 월드 탭은 지도 없이 안내만 보여 준다', () => {
    render(<PublicMapView data={data} now={now} />);
    fireEvent.click(tabs()[2]!);
    expect(screen.getByRole('tabpanel').textContent).toBe('아직 공개 지도가 없습니다');
    expect(screen.queryByTestId('world-map')).toBeNull();
    expect(screen.queryByTestId('public-map-when')).toBeNull();
  });

  it('공개할 월드가 없으면 탭 줄도 문구도 없이 자리만 둔다', () => {
    render(<PublicMapView data={{ delayMinutes: 10, worlds: [] }} now={now} />);
    const area = screen.getByTestId('public-map');
    expect(area.getAttribute('data-empty')).toBe('true');
    expect(area.textContent).toBe('');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('응답을 받기 전에도 문구 없이 자리만 둔다', () => {
    render(<PublicMapView data={undefined} now={now} />);
    expect(screen.getByTestId('public-map').textContent).toBe('');
  });
});

describe('공개 범위', () => {
  // 서버 응답 모양(T2-24)대로 도시 key·links는 문자열이다.
  const rawCity = (key: number, nationId: number | null, links: number[] = []) => ({
    ...city(key, nationId, links),
    key: String(key),
    links: links.map(String),
  });
  // 서버가 실수로 공개 범위 밖 값을 섞어 보낸 응답.
  const raw = {
    delayMinutes: 10,
    secret: 'x',
    worlds: [
      {
        id: 'w1',
        name: '첫 천하',
        status: 'RUNNING',
        ownerId: 'u1',
        map: {
          takenAt: takenAt(14, 10),
          year: 190,
          month: 3,
          tick: 5,
          cities: [
            { ...rawCity(1, 1, [2]), supplied: false, generals: [{ name: '조조' }], troops: 5000, population: 1 },
            { ...rawCity(2, 1, [1]), supplied: false },
          ],
          nations: [{ id: 1, name: '위', color: '#000080', gold: 9999, rice: 9999 }],
          generals: [{ id: 1, name: '조조', crew: 5000 }],
        },
      },
      { id: 'w9', name: '끝난 천하', status: 'ENDED', map: null },
      { id: 'w8', name: '준비 천하', status: 'PREPARING', map: null },
    ],
  };

  it('공개 범위 안의 키만 남기고 RUNNING·PAUSED 밖의 월드는 버린다', () => {
    expect(toPublicMaps(raw)).toEqual({
      delayMinutes: 10,
      worlds: [
        {
          id: 'w1',
          name: '첫 천하',
          status: 'RUNNING',
          map: {
            takenAt: takenAt(14, 10),
            year: 190,
            month: 3,
            cities: [city(1, 1, [2]), city(2, 1, [1])],
            nations: [{ id: 1, name: '위', color: '#000080' }],
          },
        },
      ],
    });
  });

  it('섞여 온 보급·장수·병력 값은 화면에 나오지 않는다', () => {
    render(<PublicMapView data={toPublicMaps(raw)} now={now} />);
    const area = screen.getByTestId('public-map');
    expect(tabs()).toHaveLength(1);
    expect(screen.getByRole('img', { name: '도시1, 위' })).toBeTruthy();
    expect(area.querySelector('[data-cut]')).toBeNull();
    expect(area.querySelector('[data-supplied]')).toBeNull();
    expect(area.textContent).not.toMatch(/조조|5000|9999|보급|내 위치/);
  });

  it('숫자로 읽을 수 없는 도시 키와 연결은 버리고 사본 없는 월드는 그대로 둔다', () => {
    const map = raw.worlds[0]!.map;
    const odd = toPublicMaps({
      delayMinutes: 10,
      worlds: [
        {
          id: 'w1',
          name: '첫 천하',
          status: 'PAUSED',
          map: {
            ...map,
            cities: [
              { ...rawCity(1, 1), links: ['2', '', '-3', '1.5'] },
              { ...rawCity(2, 1), key: 'x2' },
            ],
          },
        },
        { id: 'w2', name: '둘째 천하', status: 'RUNNING', map: null },
      ],
    });
    expect(odd.worlds[0]!.map!.cities).toEqual([city(1, 1)]);
    expect(odd.worlds[1]).toEqual({ id: 'w2', name: '둘째 천하', status: 'RUNNING', map: null });
  });

  it('모양이 틀린 응답과 사본은 버린다', () => {
    expect(toPublicMaps(null)).toEqual({ delayMinutes: 0, worlds: [] });
    const broken = toPublicMaps({
      delayMinutes: -1,
      worlds: [{ id: 'w1', name: '첫 천하', status: 'RUNNING', map: { takenAt: 'not-a-date', year: 190, month: 3 } }],
    });
    expect(broken).toEqual({ delayMinutes: 0, worlds: [{ id: 'w1', name: '첫 천하', status: 'RUNNING', map: null }] });
  });
});

describe('기준 시각 줄', () => {
  it('사본 연월과 찍은 실제 시각을 쓰고 오늘이 아니면 날짜를 붙인다', () => {
    expect(snapshotTimeText({ takenAt: takenAt(0, 5), year: 190, month: 1 }, now)).toBe(
      '190년 1월 · 오전 12시 5분 기준',
    );
    expect(snapshotTimeText({ takenAt: takenAt(12, 0), year: 190, month: 1 }, now)).toBe('190년 1월 · 오후 12시 기준');
    const yesterday = new Date(2026, 9, 22, 23, 50).toISOString();
    expect(snapshotTimeText({ takenAt: yesterday, year: 190, month: 1 }, now)).toBe(
      '190년 1월 · 10월 22일 오후 11시 50분 기준',
    );
  });
});
