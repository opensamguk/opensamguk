import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { toGameDate } from '../clock/clock';
import { monthlyDate } from '../monthly';
import { appendMonthlyReview, appendReputationEvents, readReputationLedger } from './ledger';
import { monthlyReviewSchema, reputationEventSchema, type ReputationEventRecord, type ReputationKind } from './schema';
import { buildMonthlyReview } from './settle';
import { REPUTATION_LINES } from './lines';

const date = { year: 191, month: 1, tick: 10000 };
const event = (generalId: number, kind: ReputationKind, tick = generalId): ReputationEventRecord => ({
  generalId,
  ...toGameDate(191, tick),
  tick,
  kind,
  score: { conquest: 5, victory: 3, domestic: 2, betrayal: -3, defeat: -2 }[kind],
  data: {
    name: `장수${generalId}`,
    nation: { id: 1, name: '국가', color: '#123456' },
    city: ['conquest', 'victory', 'defeat'].includes(kind) ? { cityKey: 1, name: '공개성' } : null,
  },
});
const build = (events: ReputationEventRecord[], current = date) =>
  buildMonthlyReview(events, current, rngFor('월단평', 'review', current.year, current.month));

it('T3-07 AC-M3-15 같은 종류는 처음 기록만 남기고 다음 달과 다른 종류는 따로 센다', () => {
  const first = event(1, 'victory', 1000),
    earlier = event(1, 'victory', 1);
  const before = { events: [first], reviews: [] };
  Object.freeze(before);
  Object.freeze(before.events);
  const next = appendReputationEvents(before, [earlier, event(1, 'victory', 10000), event(1, 'domestic', 2)]);
  expect(next.events).toHaveLength(3);
  expect(next.events.find((row) => row.month === 1 && row.kind === 'victory')?.tick).toBe(1000);
  expect(before.events).toEqual([first]);
  expect(build(next.events).entries[0]).toMatchObject({ score: 5, kinds: ['victory', 'domestic'] });
  expect(build(next.events, { year: 191, month: 2, tick: 20000 }).entries[0]?.score).toBe(3);
});

it('T3-07 AC-M3-15 양수 상위 다섯 명은 점수·양수 사건 수·장수 ID 순이다', () => {
  const events = [
    event(1, 'conquest'),
    event(2, 'victory'),
    event(2, 'domestic'),
    event(3, 'conquest'),
    event(3, 'betrayal'),
    event(3, 'domestic'),
    event(4, 'victory'),
    event(4, 'domestic'),
    event(4, 'defeat'),
    event(5, 'victory'),
    event(6, 'conquest'),
    event(7, 'domestic'),
    event(8, 'domestic'),
    event(8, 'defeat'),
    event(9, 'betrayal'),
  ];
  const result = build(events);
  expect(result.entries.map((row) => row.generalId)).toEqual([2, 1, 6, 3, 4]);
  expect(result.entries.map((row) => row.score)).toEqual([5, 5, 5, 4, 3]);
  expect(result.entries.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  expect(result.headline).toBe('191년 1월 월단평 1위 장수2, 2위 장수1, 3위 장수6, 4위 장수3, 5위 장수4');
  expect(build([...events].reverse())).toEqual(result);
});

it('T3-07 AC-M3-15 마지막 사건의 공개 이름·소속과 대표 사건의 공개 도시를 쓴다', () => {
  const captured = event(1, 'conquest', 1),
    resigned = event(1, 'betrayal', 2);
  resigned.data = { name: '변경된이름', nation: null, city: null };
  const result = build([resigned, captured]).entries[0]!;
  expect(result).toMatchObject({ name: '변경된이름', nation: null, score: 2, kinds: ['conquest', 'betrayal'] });
  expect(result.line).toContain('변경된이름');
  expect(result.line).toContain('공개성');
  expect(result.line).not.toContain('장수1');
});

it('T3-07 AC-M3-15 빈 달과 양수 없는 달은 빈 순위이며 난수를 쓰지 않는다', () => {
  const rng = rngFor('빈달'),
    expected = rngFor('빈달');
  expect(buildMonthlyReview([], date, rng)).toEqual({ ...date, entries: [], headline: null });
  expect(rng.next()).toBe(expected.next());
  expect(build([event(1, 'domestic'), event(1, 'defeat'), event(2, 'betrayal')]).entries).toEqual([]);
});

it('T3-07 AC-M3-15 기존 자원에서 허용한 긴 공개 이름을 보존한다', () => {
  const entry = event(1, 'domestic');
  entry.data.name = '가'.repeat(120);
  const review = build([entry]);
  expect(review.entries[0]?.name).toBe(entry.data.name);
  expect(review.entries[0]?.line).toContain(entry.data.name);
});

it('T3-07 AC-M3-15 연도 0과 10000 이후도 기존 달력 범위로 처리한다', () => {
  for (const [startYear, tick] of [
    [0, 0],
    [10000, 120000],
  ] as const) {
    const occurred = { ...event(1, 'victory', tick), ...toGameDate(startYear, tick) };
    const boundary = tick + 10000;
    const date = { ...monthlyDate(startYear, boundary), tick: boundary };
    const empty = buildMonthlyReview([], date, rngFor('빈달', startYear));
    const ledger = appendMonthlyReview(appendReputationEvents({ events: [], reviews: [] }, [occurred]), empty);
    expect(readReputationLedger(ledger, startYear)).toEqual(ledger);
    expect(buildMonthlyReview([occurred], date, rngFor('사건', startYear)).entries[0]?.score).toBe(3);
  }
  for (const year of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => monthlyReviewSchema.parse({ ...date, year, entries: [], headline: null })).toThrow();
});

it('T3-07 AC-M3-15 사건 날짜와 정산 날짜는 달·연도 경계에서 일치한다', () => {
  for (const boundary of [10000, 120000, 130000]) {
    const closing = monthlyDate(191, boundary);
    expect(toGameDate(191, boundary - 1)).toEqual(closing);
    expect(toGameDate(191, boundary)).not.toEqual(closing);
    const review = build([], { ...closing, tick: boundary });
    const ledger = appendMonthlyReview({ events: [event(1, 'victory', boundary - 1)], reviews: [] }, review);
    expect(readReputationLedger(ledger, 191)).toEqual(ledger);
    expect(() => appendMonthlyReview(ledger, review)).toThrow('같은 달');
  }
});

it('T3-07 AC-M3-15 손상 원장·중복·정렬·합계·제목을 거부하고 과거 달을 보존한다', () => {
  const ledger = appendReputationEvents({ events: [], reviews: [] }, [event(2, 'victory'), event(1, 'domestic')]);
  expect(readReputationLedger(ledger, 191).events.map((row) => row.generalId)).toEqual([1, 2]);
  expect(() => readReputationLedger({ ...ledger, events: [...ledger.events].reverse() }, 191)).toThrow();
  expect(() => readReputationLedger({ ...ledger, events: [...ledger.events, ledger.events[1]] }, 191)).toThrow();
  expect(() => readReputationLedger({ ...ledger, events: [{ ...ledger.events[0], month: 2 }] }, 191)).toThrow();
  expect(() => reputationEventSchema.parse({ ...event(1, 'victory'), score: 100 })).toThrow();
  const review = build(ledger.events);
  expect(() => monthlyReviewSchema.parse({ ...review, headline: '다른 제목' })).toThrow();
  expect(() => monthlyReviewSchema.parse({ ...review, entries: [{ ...review.entries[0], score: 9 }] })).toThrow();
  let full = ledger;
  for (let index = 1; index <= 25; index++) {
    const closing = monthlyDate(191, index * 10000);
    full = appendMonthlyReview(full, build([], { ...closing, tick: index * 10000 }));
  }
  expect(readReputationLedger(full, 191).reviews).toHaveLength(25);
  expect(full.events).toEqual(ledger.events);
});

it('T3-07 AC-M3-15 종류마다 세 문장이 있고 내정 위치·수치를 문장에 싣지 않는다', () => {
  for (const [kind, lines] of Object.entries(REPUTATION_LINES)) {
    expect(lines.length).toBeGreaterThanOrEqual(3);
    if (kind === 'domestic' || kind === 'betrayal')
      for (const line of lines) expect(line({ name: '관우', city: '비공개도시' })).not.toContain('비공개도시');
  }
  expect(REPUTATION_LINES.victory[0]!({ name: '관우', city: null })).toContain('관우가');
  expect(REPUTATION_LINES.victory[0]!({ name: '조운', city: null })).toContain('조운이');
  expect(() =>
    reputationEventSchema.parse({
      ...event(1, 'domestic'),
      data: {
        ...event(1, 'domestic').data,
        city: { cityKey: 99, name: '비공개도시' },
      },
    }),
  ).toThrow();
});
