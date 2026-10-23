import { createRng } from '@opensamguk/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createBracket,
  MAX_BRACKET_PARTICIPANTS,
  MAX_PARTICIPANT_ID,
  MIN_BRACKET_PARTICIPANTS,
  type Bracket,
  type BracketMatch,
  type BracketSlot,
} from './bracket';

const participant = (participantId: number): BracketSlot => ({ kind: 'participant', participantId });
const bye = (): BracketSlot => ({ kind: 'bye' });
const winner = (round: number, index: number): BracketSlot => ({ kind: 'winnerOf', round, index });
const match = (round: number, index: number, home: BracketSlot, away: BracketSlot): BracketMatch => ({
  round,
  index,
  home,
  away,
});
const eightSlotFinals = [
  [match(2, 0, winner(1, 0), winner(1, 1)), match(2, 1, winner(1, 2), winner(1, 3))],
  [match(3, 0, winner(2, 0), winner(2, 1))],
];
// Claude 계획의 G1~G5. 구현으로 기대값을 다시 생성하지 않는다.
const goldenSix: Bracket = {
  size: 8,
  byes: [5, 2],
  rounds: [
    [
      match(1, 0, participant(5), bye()),
      match(1, 1, participant(2), bye()),
      match(1, 2, participant(3), participant(4)),
      match(1, 3, participant(1), participant(6)),
    ],
    ...eightSlotFinals,
  ],
};

function trackedRng(seed = 'T4-30 golden') {
  const source = createRng(seed);
  const rng = {
    next: vi.fn(() => source.next()),
    int: vi.fn((min: number, max: number) => source.int(min, max)),
    pick: source.pick,
  };
  vi.spyOn(rng, 'pick');
  return { source, rng };
}

function expectStructure(bracket: Bracket, participants: readonly number[]) {
  const firstRound = bracket.rounds[0]!;
  const ids = firstRound.flatMap(({ home, away }) =>
    [home, away].flatMap((slot) => (slot.kind === 'participant' ? [slot.participantId] : [])),
  );
  expect(ids.toSorted((a, b) => a - b)).toEqual(participants.toSorted((a, b) => a - b));
  expect(new Set(ids).size).toBe(participants.length);
  expect(bracket.size).toBeGreaterThanOrEqual(participants.length);
  expect(bracket.size / 2).toBeLessThan(participants.length);
  expect(Number.isInteger(Math.log2(bracket.size))).toBe(true);
  expect(bracket.byes.length).toBe(bracket.size - participants.length);
  expect(bracket.rounds.length).toBe(Math.log2(bracket.size));
  expect(bracket.rounds.flat().length).toBe(bracket.size - 1);
  expect(bracket.rounds.at(-1)).toHaveLength(1);
  const byeIds = firstRound.flatMap(({ home, away }) => {
    expect(home.kind).toBe('participant');
    expect(away.kind).not.toBe('winnerOf');
    return home.kind === 'participant' && away.kind === 'bye' ? [home.participantId] : [];
  });
  expect(byeIds).toEqual(bracket.byes);
  for (const [offset, matches] of bracket.rounds.entries()) {
    const round = offset + 1;
    expect(matches).toHaveLength(bracket.size / 2 ** round);
    for (const [index, value] of matches.entries()) {
      expect(value.round).toBe(round);
      expect(value.index).toBe(index);
      if (round > 1) {
        expect(value.home).toEqual(winner(round - 1, index * 2));
        expect(value.away).toEqual(winner(round - 1, index * 2 + 1));
        const previous = bracket.rounds[offset - 1]!;
        expect(previous[index * 2]).toBeDefined();
        expect(previous[index * 2 + 1]).toBeDefined();
      }
    }
  }
}

describe('T4-30 종목 독립 대진', () => {
  it('G1·G2: 6명 대진과 모든 후속 연결이 고정되고 입력 순서에 무관하다', () => {
    const { rng } = trackedRng();
    expect(createBracket([1, 2, 3, 4, 5, 6], rng)).toEqual(goldenSix);
    expect(rng.int.mock.results.map((result) => result.value)).toEqual([5, 0, 3, 2, 1]);
    for (const ids of [
      [6, 5, 4, 3, 2, 1],
      [6, 2, 5, 1, 4, 3],
    ]) {
      expect(createBracket(ids, createRng('T4-30 golden'))).toEqual(goldenSix);
    }
  });

  it('G3: 5명일 때 추첨 앞 3명에게 부전승을 배정한다', () => {
    const { rng } = trackedRng();
    expect(createBracket([101, 202, 303, 404, 505], rng)).toEqual({
      size: 8,
      byes: [404, 202, 303],
      rounds: [
        [
          match(1, 0, participant(404), bye()),
          match(1, 1, participant(202), bye()),
          match(1, 2, participant(303), bye()),
          match(1, 3, participant(101), participant(505)),
        ],
        ...eightSlotFinals,
      ],
    });
    expect(rng.int.mock.results.map((result) => result.value)).toEqual([4, 0, 2, 1]);
  });

  it('G4: 2명은 부전승과 후속 라운드 없이 결승 한 경기다', () => {
    const { rng } = trackedRng();
    expect(createBracket([7, 9], rng)).toEqual({
      size: 2,
      byes: [],
      rounds: [[match(1, 0, participant(7), participant(9))]],
    });
    expect(rng.int.mock.results.map((result) => result.value)).toEqual([1]);
  });

  it('G5: 다른 시드의 대진도 고정 기대값과 같다', () => {
    const { rng } = trackedRng('T4-30 other');
    const result = createBracket([1, 2, 3, 4, 5, 6], rng);
    expect(result).toEqual({
      size: 8,
      byes: [3, 6],
      rounds: [
        [
          match(1, 0, participant(3), bye()),
          match(1, 1, participant(6), bye()),
          match(1, 2, participant(2), participant(5)),
          match(1, 3, participant(1), participant(4)),
        ],
        ...eightSlotFinals,
      ],
    });
    expect(result).not.toEqual(goldenSix);
    expect(rng.int.mock.results.map((value) => value.value)).toEqual([3, 0, 0, 1, 0]);
  });

  it('ID를 문자열 순서가 아닌 숫자 순서로 정렬한 뒤 추첨한다', () => {
    expect(createBracket([10, 2, 1], createRng('T4-30 golden'))).toEqual({
      size: 4,
      byes: [2],
      rounds: [
        [match(1, 0, participant(2), bye()), match(1, 1, participant(1), participant(10))],
        [match(2, 0, winner(1, 0), winner(1, 1))],
      ],
    });
  });

  it.each([
    [2, 2, 0],
    [3, 4, 1],
    [4, 4, 0],
    [5, 8, 3],
    [8, 8, 0],
    [9, 16, 7],
    [1023, 1024, 1],
    [1024, 1024, 0],
  ])('%i명의 경계에서 크기 %i·부전승 %i·RNG 소비를 지킨다', (count, size, byes) => {
    const ids = Array.from({ length: count }, (_, index) => index + 1);
    const { rng, source } = trackedRng();
    const result = createBracket(ids, rng);
    expect(result.size).toBe(size);
    expect(result.byes).toHaveLength(byes);
    expectStructure(result, ids);
    expect(rng.int.mock.calls).toEqual(Array.from({ length: count - 1 }, (_, index) => [0, count - index - 1]));
    expect(rng.next).not.toHaveBeenCalled();
    expect(rng.pick).not.toHaveBeenCalled();
    const reference = createRng('T4-30 golden');
    for (let index = 0; index < count - 1; index++) reference.next();
    expect(source.next()).toBe(reference.next());
  });

  it.each(Array.from({ length: 63 }, (_, index) => index + 2))(
    '%i명과 여러 실제 시드에서 참가자·부전승·후속 연결 불변식을 지킨다',
    (count) => {
      const ids = Array.from({ length: count }, (_, index) => index * 11 + 1);
      for (const seed of ['T4-30 invariant A', 'T4-30 invariant B', '']) {
        const result = createBracket(ids, createRng(seed));
        expectStructure(result, ids);
        expect(createBracket(ids.toReversed(), createRng(seed))).toEqual(result);
      }
    },
  );

  it('상한 1024명에서 ID 양끝과 결정성을 지킨다', () => {
    expect([MIN_BRACKET_PARTICIPANTS, MAX_BRACKET_PARTICIPANTS, MAX_PARTICIPANT_ID]).toEqual([2, 1024, 2147483647]);
    const ids = Array.from({ length: 1024 }, (_, index) => (index === 1023 ? MAX_PARTICIPANT_ID : index + 1));
    const a = trackedRng('upper-bound');
    const b = trackedRng('upper-bound');
    const result = createBracket(ids, a.rng);
    expect(createBracket(ids.toReversed(), b.rng)).toEqual(result);
    expectStructure(result, ids);
    expect(a.rng.int).toHaveBeenCalledTimes(1023);
    expect(b.rng.int).toHaveBeenCalledTimes(1023);
    expect(a.source.next()).toBe(b.source.next());
  });

  it('얼린 입력을 보존하고 결과를 고쳐도 입력과 다음 호출에 영향이 없다', () => {
    const ids = Object.freeze([3, 1, 2]);
    const result = createBracket(ids, createRng('immutable'));
    const expected = structuredClone(result);
    expect(ids).toEqual([3, 1, 2]);
    const first = result.rounds[0]![0]!;
    if (first.home.kind !== 'participant') throw new Error('참가자 칸이 필요합니다.');
    first.home.participantId = 999;
    expect(ids).toEqual([3, 1, 2]);
    expect(createBracket(ids, createRng('immutable'))).toEqual(expected);
    expect(result.byes).toEqual(expected.byes);
  });

  const sparse = [1, 2, 3];
  delete sparse[1];
  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['객체', { 0: 1, 1: 2, length: 2 }],
    ['문자열', '12'],
    ['typed array', new Int32Array([1, 2])],
    ['0명', []],
    ['1명', [7]],
    ['1025명', Array.from({ length: 1025 }, (_, index) => index + 1)],
    ['빈칸', sparse],
    ['모두 빈칸', new Array(2)],
    ['중복', [3, 3]],
    ['멀리 있는 중복', [3, 1, 2, 3]],
    ...[
      0,
      -0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      2147483648,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
      undefined,
      1n,
    ].map((id): [string, unknown] => [`비정상 ID ${String(id)}`, [2, id]]),
  ];

  it.each(invalid)('%s 입력은 RNG를 쓰기 전에 거부한다', (_, value) => {
    const { rng, source } = trackedRng();
    expect(() => createBracket(value as readonly number[], rng)).toThrow(Error);
    expect(rng.int).not.toHaveBeenCalled();
    expect(rng.next).not.toHaveBeenCalled();
    expect(rng.pick).not.toHaveBeenCalled();
    expect(source.next()).toBe(createRng('T4-30 golden').next());
  });
});
