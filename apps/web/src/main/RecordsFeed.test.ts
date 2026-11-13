import { describe, expect, it } from 'vitest';
import {
  activityKey,
  activityLine,
  battleKey,
  battleText,
  flattenPages,
  groupByMonth,
  reputationSentence,
  reviewLines,
  subject,
  worldTimeline,
  yearbookSummary,
  type ActivityItem,
  type ReputationItem,
  type FeedLine,
  type WorldItem,
} from './RecordsFeed';

// records.activity 응답 모양의 synthetic 항목이다. 실제 API 증거가 아니다.
const wei = { id: 1, name: '위', color: '#000080' };
const reputation = (
  id: string,
  tick: number,
  kind: 'conquest' | 'victory' | 'defeat' | 'domestic' | 'betrayal',
  extra: { name?: string; nation?: typeof wei | null; city?: string | null; month?: number } = {},
): ReputationItem => ({
  id,
  source: 'reputation',
  generalId: 7,
  portraitId: 7,
  year: 191,
  month: extra.month ?? 3,
  kind,
  score: 1,
  tick,
  data: {
    name: extra.name ?? '조조(曹操)',
    nation: extra.nation === undefined ? wei : extra.nation,
    city: extra.city ? { cityKey: 5, name: extra.city } : null,
  },
});
const nationEvent = (
  id: string,
  tick: number,
  text: string,
  month = 3,
  kind: 'found' | 'fall' | 'declare' | 'capture' = 'capture',
): ActivityItem => ({ source: 'nation', id, tick, year: 191, month, kind, text, portraitId: null });

describe('장수 동향 문장', () => {
  it('받침에 따라 이·가를 고른다', () => {
    expect(subject('조조')).toBe('조조가');
    expect(subject('관우')).toBe('관우가');
    expect(subject('손권')).toBe('손권이');
    expect(subject('Lee')).toBe('Lee가');
  });

  it('평판 사건 종류마다 괄호를 뺀 이름과 공개 도시로 문장을 만든다', () => {
    expect(reputationSentence(reputation('1', 10, 'conquest', { city: '허창' }))).toBe('조조가 허창 점령을 이끌었다.');
    expect(reputationSentence(reputation('1', 10, 'victory', { city: '허창' }))).toBe('조조가 허창 교전에서 이겼다.');
    expect(reputationSentence(reputation('1', 10, 'defeat', { name: '손권', city: '합비' }))).toBe(
      '손권이 합비 교전에서 졌다.',
    );
    expect(reputationSentence(reputation('1', 10, 'domestic'))).toBe('조조가 내정 목표를 채웠다.');
    expect(reputationSentence(reputation('1', 10, 'betrayal'))).toBe('조조가 소속이나 조약의 약속을 끊었다.');
  });

  it('평판 사건은 소속 국가 이름표를, 국가 사건은 서버 문장을 그대로 쓴다', () => {
    expect(activityLine(reputation('9', 30, 'domestic'))).toEqual({
      key: 'reputation:9',
      tick: 30,
      year: 191,
      month: 3,
      source: 'reputation',
      portrait: { id: 7, name: '조조' },
      kind: 'domestic',
      text: '조조가 내정 목표를 채웠다.',
      nation: { name: '위', color: '#000080' },
    });
    expect(activityLine(reputation('9', 30, 'domestic', { nation: null })).nation).toBeNull();
    expect(activityLine(nationEvent('4', 20, '위의 성도 점령'))).toEqual({
      key: 'nation:4',
      tick: 20,
      year: 191,
      month: 3,
      source: 'nation',
      kind: 'capture',
      text: '위의 성도 점령',
    });
  });
});

describe('이어 받은 쪽 펴기', () => {
  it('쪽 순서를 지키고 같은 원장의 같은 id는 한 번만 남긴다', () => {
    const pages = [
      { items: [reputation('3', 30, 'domestic'), nationEvent('3', 30, '위 건국', 3, 'found')] },
      { items: [nationEvent('3', 30, '위 건국', 3, 'found'), reputation('2', 20, 'domestic')] },
    ];
    expect(flattenPages(pages, activityKey).map(activityKey)).toEqual(['reputation:3', 'nation:3', 'reputation:2']);
  });

  it('전투 기록은 tick과 공격 장수로 가른다', () => {
    const a = { tick: 5, attackerId: 1, portraitId: null, text: 'a', gameDate: { year: 191, month: 1 } };
    const b = { tick: 5, attackerId: 2, portraitId: null, text: 'b', gameDate: { year: 191, month: 1 } };
    expect(flattenPages([{ items: [a, b] }, { items: [b] }], battleKey)).toEqual([a, b]);
  });

  it('전투 글의 장수 이름 괄호를 빼고 띄어쓰기는 남긴다', () => {
    expect(battleText('조조(曹操) 대 유비(劉備): 공격 900명, 수비 0명')).toBe('조조 대 유비: 공격 900명, 수비 0명');
    expect(battleText('방랑 동행: 허창')).toBe('방랑 동행: 허창');
  });
});

describe('중원 정세 줄', () => {
  const event = (tick: number, month: number): FeedLine =>
    activityLine(nationEvent(String(tick), tick, `사건 ${tick}`, month));
  const yearbookMonth = (tick: number, month: number, headline?: string): WorldItem => ({
    tick,
    year: 191,
    month,
    nations: [
      { nationId: 1, cities: 2, generals: 3 },
      { nationId: 2, cities: 0, generals: 1 },
    ],
    cities: [
      { cityKey: 1, nationId: 1 },
      { cityKey: 2, nationId: 1 },
      { cityKey: 3, nationId: null },
    ],
    ...(headline ? { review: { headline } } : {}),
  });

  it('월단평 머리글을 그 달 정산 자리에 끼우고 같은 tick이면 앞에 둔다', () => {
    const reviews = reviewLines([yearbookMonth(30, 3, '191년 3월 월단평 1위 조조'), yearbookMonth(20, 2)]);
    expect(reviews.map((line) => line.text)).toEqual(['월단평: 191년 3월 월단평 1위 조조']);
    const lines = worldTimeline([event(40, 4), event(30, 3), event(10, 1)], reviews, false);
    expect(lines.map((line) => line.key)).toEqual(['nation:40', 'review:30', 'nation:30', 'nation:10']);
  });

  it('사건이 더 남아 있으면 불러온 마지막 사건보다 오래된 머리글은 아직 쓰지 않는다', () => {
    const reviews = reviewLines([yearbookMonth(30, 3, '셋째 달'), yearbookMonth(10, 1, '첫 달')]);
    const events = [event(40, 4), event(20, 2)];
    expect(worldTimeline(events, reviews, true).map((line) => line.key)).toEqual([
      'nation:40',
      'review:30',
      'nation:20',
    ]);
    expect(worldTimeline(events, reviews, false).map((line) => line.key)).toEqual([
      'nation:40',
      'review:30',
      'nation:20',
      'review:10',
    ]);
    // 사건이 하나도 없으면 머리글만 쓴다.
    expect(worldTimeline([], reviews, false).map((line) => line.key)).toEqual(['review:30', 'review:10']);
  });

  it('이어진 같은 연월끼리 묶는다', () => {
    const months = groupByMonth([event(40, 4), event(39, 4), event(30, 3), event(5, 4)]);
    expect(months.map((month) => [month.month, month.lines.length])).toEqual([
      [4, 2],
      [3, 1],
      [4, 1],
    ]);
    expect(new Set(months.map((month) => month.key)).size).toBe(3);
  });

  it('사건이 없을 때 쓰는 세력 수 줄은 도시가 있는 세력과 공백지만 센다', () => {
    expect(yearbookSummary(yearbookMonth(30, 3))).toBe('세력 1곳 · 공백지 1성');
  });
});
