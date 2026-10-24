import { createRng, type Rng } from '@opensamguk/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveTournamentMatch,
  TOURNAMENT_EVENTS,
  TOURNAMENT_MAX_PHASES,
  type TournamentEvent,
  type TournamentFighter,
  type TournamentMatchResult,
} from './match';

type MatchInput = Parameters<typeof resolveTournamentMatch>[0];
const fighter = (participantId: number, leadership: number, strength: number, intel: number): TournamentFighter => ({
  participantId,
  leadership,
  strength,
  intel,
});
const home = fighter(11, 70, 80, 60);
const away = fighter(22, 90, 40, 75);
const inputFor = (event: TournamentEvent, h = home, a = away): MatchInput => ({ event, home: h, away: a });

function trackedRng(seed = 'T4-54 golden') {
  const source = createRng(seed);
  const rng = {
    int: vi.fn((min: number, max: number) => source.int(min, max)),
    next: vi.fn(() => source.next()),
    pick: source.pick,
  };
  vi.spyOn(rng, 'pick');
  return { source, rng };
}

// Claude 계획 G1~G6의 고정 값이다. 구현으로 다시 생성하지 않는다.
const goldens = [
  {
    id: 'G1',
    event: 'total',
    h: home,
    a: away,
    seed: 'T4-54 golden',
    start: [980, 957],
    end: [-9, -76],
    phases: 11,
    winner: 11,
    reason: 'double-knockout',
    calls: 85,
  },
  {
    id: 'G2',
    event: 'strength',
    h: home,
    a: away,
    seed: 'T4-54 golden',
    start: [800, 400],
    end: [619, -26],
    phases: 5,
    winner: 11,
    reason: 'knockout',
    calls: 38,
  },
  {
    id: 'G3',
    event: 'intel',
    h: home,
    a: away,
    seed: 'T4-54 golden',
    start: [600, 750],
    end: [-13, 210],
    phases: 8,
    winner: 22,
    reason: 'knockout',
    calls: 61,
  },
  {
    id: 'G4',
    event: 'leadership',
    h: fighter(11, 50, 50, 50),
    a: fighter(22, 50, 50, 50),
    seed: 'T4-54 golden',
    start: [500, 500],
    end: [7, -13],
    phases: 11,
    winner: 11,
    reason: 'knockout',
    calls: 78,
  },
  {
    id: 'G5',
    event: 'strength',
    h: fighter(11, 0, 0, 0),
    a: fighter(22, 0, 0, 0),
    seed: 'T4-54 golden',
    start: [0, 0],
    end: [0, 0],
    phases: 1,
    winner: 22,
    reason: 'double-knockout',
    calls: 4,
  },
  {
    id: 'G6',
    event: 'total',
    h: home,
    a: away,
    seed: 'T4-54 other',
    start: [980, 957],
    end: [10, -68],
    phases: 10,
    winner: 11,
    reason: 'knockout',
    calls: 81,
  },
] as const;

function checkInvariants(input: MatchInput, result: TournamentMatchResult): void {
  const check = (condition: boolean, id: string) => {
    if (!condition) throw new Error(`${id}: ${JSON.stringify({ input, result })}`);
  };
  check(
    (result.winnerId === input.home.participantId && result.loserId === input.away.participantId) ||
      (result.winnerId === input.away.participantId && result.loserId === input.home.participantId),
    'M2',
  );
  check(result.exchanges.length >= 1 && result.exchanges.length <= 100, 'M3');
  let h = result.initialEnergy.home;
  let a = result.initialEnergy.away;
  for (const [index, exchange] of result.exchanges.entries()) {
    check(exchange.phase === index + 1, 'M3');
    check(
      Number.isInteger(exchange.homeDamage) &&
        exchange.homeDamage >= 0 &&
        Number.isInteger(exchange.awayDamage) &&
        exchange.awayDamage >= 0,
      'M5',
    );
    h -= exchange.homeDamage;
    a -= exchange.awayDamage;
    check(exchange.homeEnergy === h && exchange.awayEnergy === a, 'M5');
    if (index < result.exchanges.length - 1) check(h > 0 && a > 0, 'M4');
  }
  if (result.decidedBy === 'phase-limit') {
    check(result.exchanges.length === 100 && h > 0 && a > 0, 'M9');
  } else if (result.decidedBy === 'double-knockout') {
    check(h <= 0 && a <= 0, 'M9');
  } else {
    check(result.decidedBy === 'knockout' && ((h <= 0 && a > 0) || (a <= 0 && h > 0)), 'M9');
  }
  check(result.winnerId === (h > a ? input.home.participantId : input.away.participantId), 'M9');
}

describe('T4-54 순수 토너먼트 경기', () => {
  it.each(goldens)('$id: 시작·끝 기력, 승자, 합 수와 RNG 소비를 보존한다', (golden) => {
    const input = inputFor(golden.event, golden.h, golden.a);
    const { rng, source } = trackedRng(golden.seed);
    const result = resolveTournamentMatch(input, rng);
    const last = result.exchanges.at(-1)!;
    expect(result.initialEnergy).toEqual({ home: golden.start[0], away: golden.start[1] });
    expect([last.homeEnergy, last.awayEnergy]).toEqual(golden.end);
    expect(result.exchanges).toHaveLength(golden.phases);
    expect(result).toMatchObject({
      winnerId: golden.winner,
      loserId: golden.winner === 11 ? 22 : 11,
      decidedBy: golden.reason,
    });
    expect(rng.int).toHaveBeenCalledTimes(golden.calls);
    expect(rng.next).not.toHaveBeenCalled();
    expect(rng.pick).not.toHaveBeenCalled();
    const reference = createRng(golden.seed);
    for (let index = 0; index < golden.calls; index++) reference.next();
    expect(source.next()).toBe(reference.next());
    expect(resolveTournamentMatch(input, createRng(golden.seed))).toEqual(result);
    checkInvariants(input, result);
    if (golden.id === 'G1') {
      expect(result.exchanges.map(({ homeEnergy, awayEnergy }) => [homeEnergy, awayEnergy])).toEqual([
        [886, 855],
        [808, 757],
        [709, 648],
        [617, 558],
        [512, 461],
        [415, 365],
        [331, 282],
        [226, 192],
        [158, 113],
        [68, 19],
        [-9, -76],
      ]);
    }
    if (golden.id === 'G3') {
      expect(result.exchanges[6]!.homeFury).toBe(true);
      expect(rng.int.mock.calls).toContainEqual([0, 300]);
      expect(rng.int.mock.calls).toContainEqual([0, 301]);
    }
  });

  it('첫 합의 RNG 범위와 조건의 단락 순서를 지킨다', () => {
    const calls: Array<[number, number, number]> = [
      [0, 21, 21],
      [0, 21, 0],
      [0, 100, 100],
      [0, 41, 41],
      [0, 100, 100],
      [0, 400, 0],
      [0, 31, 31],
    ];
    const rng: Rng = {
      int: (min, max) => {
        const call = calls.shift();
        expect(call?.slice(0, 2)).toEqual([min, max]);
        return call![2];
      },
      next: () => {
        throw new Error('next를 부르면 안 됩니다.');
      },
      pick: () => {
        throw new Error('pick을 부르면 안 됩니다.');
      },
    };
    const result = resolveTournamentMatch(inputFor('strength', fighter(11, 0, 100, 0), fighter(22, 0, 0, 0)), rng);
    expect(result.exchanges).toEqual([
      {
        phase: 1,
        homeEnergy: 1000,
        awayEnergy: -209,
        homeDamage: 0,
        awayDamage: 209,
        homeFury: false,
        awayFury: false,
      },
    ]);
    expect(result.decidedBy).toBe('knockout');
    expect(calls).toEqual([]);
  });

  it.each(['T4-54 golden', 'T4-54 other'])('X4: %s에서 낮은 종합 능력치는 100합 동률 뒤 원정이 이긴다', (seed) => {
    const { rng } = trackedRng(seed);
    const result = resolveTournamentMatch(inputFor('total', fighter(11, 1, 0, 0), fighter(22, 1, 0, 0)), rng);
    expect(result).toMatchObject({
      winnerId: 22,
      loserId: 11,
      decidedBy: 'phase-limit',
      initialEnergy: { home: 5, away: 5 },
    });
    expect(result.exchanges).toEqual(
      Array.from({ length: 100 }, (_, index) => ({
        phase: index + 1,
        homeEnergy: 5,
        awayEnergy: 5,
        homeDamage: 0,
        awayDamage: 0,
        homeFury: false,
        awayFury: false,
      })),
    );
    expect(rng.next).not.toHaveBeenCalled();
    expect(rng.pick).not.toHaveBeenCalled();
  });

  it.each(['min', 'max'] as const)('X4: RNG가 항상 %s을 뽑아도 피해를 올리거나 101합을 더하지 않는다', (edge) => {
    const int = vi.fn((min: number, max: number) => (edge === 'min' ? min : max));
    const rng: Rng = {
      int,
      next: () => {
        throw new Error('next');
      },
      pick: () => {
        throw new Error('pick');
      },
    };
    const result = resolveTournamentMatch(inputFor('total', fighter(11, 1, 0, 0), fighter(22, 1, 0, 0)), rng);
    expect(result.exchanges).toHaveLength(TOURNAMENT_MAX_PHASES);
    expect(result.exchanges.every((exchange) => exchange.homeDamage === 0 && exchange.awayDamage === 0)).toBe(true);
    expect(result.winnerId).toBe(22);
    expect(result.decidedBy).toBe('phase-limit');
    expect(int).toHaveBeenCalledTimes(edge === 'min' ? 996 : 598);
  });

  it.each([false, true])('X5·X6: 홈·원정 순서를 바꿔도 기력이 있는 쪽이 첫 합에 이긴다 (%s)', (reverse) => {
    for (const [event, low, high, energy] of [
      ['strength', [0, 0, 0], [0, 100, 0], 1000],
      ['total', [1, 0, 0], [50, 50, 50], 700],
    ] as const) {
      const hStats = reverse ? high : low;
      const aStats = reverse ? low : high;
      const h = fighter(11, hStats[0], hStats[1], hStats[2]);
      const a = fighter(22, aStats[0], aStats[1], aStats[2]);
      for (const seed of ['T4-54 golden', 'T4-54 other', '']) {
        const result = resolveTournamentMatch(inputFor(event, h, a), createRng(seed));
        expect(result).toMatchObject({ winnerId: reverse ? 11 : 22, decidedBy: 'knockout' });
        expect(result.exchanges).toHaveLength(1);
        const last = result.exchanges[0]!;
        expect(reverse ? last.homeEnergy : last.awayEnergy).toBe(energy);
        expect(reverse ? last.awayEnergy : last.homeEnergy).toBeLessThanOrEqual(event === 'total' ? -43 : 0);
      }
    }
  });

  it.each(TOURNAMENT_EVENTS)('M2~M5·M8~M10: %s의 능력치 경계 조합과 세 시드에서 불변식을 지킨다', (event) => {
    const values = [0, 1, 50, 99, 100];
    const stats = values.flatMap((l) => values.flatMap((s) => values.map((i) => [l, s, i] as const)));
    const homes = stats.map((stats) => Object.freeze(fighter(11, ...stats)));
    const aways = stats.map((stats) => Object.freeze(fighter(22, ...stats)));
    let count = 0;
    for (const h of homes)
      for (const a of aways)
        for (const seed of ['T4-54 invariant A', 'T4-54 invariant B', '']) {
          const source = createRng(seed);
          const rng: Rng = {
            int: source.int,
            next: () => {
              throw new Error('M8: next');
            },
            pick: () => {
              throw new Error('M8: pick');
            },
          };
          const input = Object.freeze(inputFor(event, h, a));
          checkInvariants(input, resolveTournamentMatch(input, rng));
          count++;
        }
    expect(count).toBe(125 * 125 * 3);
  });

  it('M6: 얼린 입력을 보존하고 결과 변경은 다음 경기에 영향을 주지 않는다', () => {
    const input = Object.freeze(inputFor('total', Object.freeze({ ...home }), Object.freeze({ ...away })));
    const before = structuredClone(input);
    const result = resolveTournamentMatch(input, createRng('T4-54 golden'));
    const expected = structuredClone(result);
    result.initialEnergy.home = -1;
    result.exchanges[0]!.homeEnergy = -1;
    expect(input).toEqual(before);
    expect(resolveTournamentMatch(input, createRng('T4-54 golden'))).toEqual(expected);
  });

  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['배열', []],
    ['문자열', 'total'],
    ['X1 같은 참가자', inputFor('total', home, { ...away, participantId: 11 })],
    ['X3 모르는 종목', { ...inputFor('total'), event: 'charm' }],
    ['종목 누락', { home, away }],
    ['홈 누락', { event: 'total', away }],
    ['원정 null', { ...inputFor('total'), away: null }],
    ['입력의 level', { ...inputFor('total'), level: 0 }],
    ['알 수 없는 symbol', { ...inputFor('total'), [Symbol('level')]: 0 }],
    ['열거되지 않는 칸', Object.defineProperty(inputFor('total'), 'level', { value: 0 })],
    ...['home', 'away'].flatMap((side): Array<[string, unknown]> => [
      [`${side} 배열`, { ...inputFor('total'), [side]: [] }],
      [`${side} 물려받은 칸`, { ...inputFor('total'), [side]: Object.create(side === 'home' ? home : away) }],
      [
        `${side} 능력치 칸 누락`,
        { ...inputFor('total'), [side]: { participantId: side === 'home' ? 11 : 22, strength: 50, intel: 50 } },
      ],
      [`${side} 객체 능력치`, { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), leadership: {} } }],
      [`${side} 배열 능력치`, { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), leadership: [] } }],
      [`${side} level`, { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), level: 0 } }],
      [`${side} 모르는 칸`, { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), other: true } }],
      ...[0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined].map(
        (id): [string, unknown] => [
          `${side} ID ${String(id)}`,
          { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), participantId: id } },
        ],
      ),
      ...['leadership', 'strength', 'intel'].flatMap((stat) =>
        [-1, 101, 1.5, NaN, Infinity, '1', null, undefined].map((value): [string, unknown] => [
          `X2 ${side} ${stat} ${String(value)}`,
          { ...inputFor('total'), [side]: { ...(side === 'home' ? home : away), [stat]: value } },
        ]),
      ),
    ]),
  ];
  it.each(invalid)('M7: %s 입력은 RNG를 쓰기 전에 거부한다', (_, input) => {
    const { rng, source } = trackedRng();
    expect(() => resolveTournamentMatch(input as MatchInput, rng)).toThrow(Error);
    expect(rng.int).not.toHaveBeenCalled();
    expect(rng.next).not.toHaveBeenCalled();
    expect(rng.pick).not.toHaveBeenCalled();
    expect(source.next()).toBe(createRng('T4-54 golden').next());
  });

  it('ID 양끝을 허용하고 등급 없는 네 종목만 공개한다', () => {
    expect(TOURNAMENT_EVENTS).toEqual(['total', 'leadership', 'strength', 'intel']);
    const input = inputFor('strength', { ...home, participantId: 1 }, { ...away, participantId: 2147483647 });
    checkInvariants(input, resolveTournamentMatch(input, createRng('id-boundary')));
  });
});
