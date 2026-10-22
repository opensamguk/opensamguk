import { describe, expect, it } from 'vitest';
import { argFields, buildArgs, describeArgs, requiredKeys } from './args';
import {
  applyOps,
  describeSelection,
  quickSelect,
  repeatRange,
  runs,
  sameTurns,
  SLOT_COUNT,
  toSaveSlots,
  toTurn,
  turnKey,
  type EditOp,
  type Turn,
} from './draft';
import { slotTimes } from './schedule';
import { draftStorageKey, readStored } from './useTurnDraft';

const farm: Turn = { commandKey: 'farm', args: {} };
const rest = (): Turn => ({ commandKey: 'rest', args: {} });
const empty = () => Array.from({ length: SLOT_COUNT }, rest);
const numbered = () => Array.from({ length: SLOT_COUNT }, (_, i): Turn => ({ commandKey: `c${i}`, args: {} }));

describe('예턴 초안 편집', () => {
  it('흩어진 칸은 이어진 구간으로 묶어 넣는다', () => {
    expect(runs([7, 1, 2, 3, 3])).toEqual([
      [1, 3],
      [7, 7],
    ]);
    const next = applyOps(empty(), [{ put: { indices: [1, 2, 3, 4], turn: farm } }]);
    expect(next.map((t) => t.commandKey).slice(0, 6)).toEqual(['rest', 'farm', 'farm', 'farm', 'farm', 'rest']);
  });

  it('밀기 1은 첫 칸을 휴식으로 채우고 뒤로 한 칸씩 민다. 당기기는 반대다', () => {
    const pushed = applyOps(numbered(), [{ shift: 1 }]);
    expect(pushed[0]).toEqual(rest());
    expect(pushed[1]!.commandKey).toBe('c0');
    expect(pushed[29]!.commandKey).toBe('c28');
    const pulled = applyOps(numbered(), [{ shift: -2 }]);
    expect(pulled[0]!.commandKey).toBe('c2');
    expect(pulled[28]).toEqual(rest());
    expect(pulled[29]).toEqual(rest());
  });

  it('반복은 편집 전 구간을 바로 뒤에 붙이고 30칸에서 자른다', () => {
    const next = applyOps(numbered(), [{ repeat: { from: 26, to: 27, times: 3 } }]);
    expect(next.slice(26).map((t) => t.commandKey)).toEqual(['c26', 'c27', 'c26', 'c27']);
    expect(next).toHaveLength(SLOT_COUNT);
  });

  it('충돌 뒤 다시 적용은 최신 목록에 같은 편집을 같은 순서로 적용한다', () => {
    const ops: EditOp[] = [{ put: { indices: [0], turn: farm } }, { shift: 1 }];
    const latest = numbered();
    const result = applyOps(latest, ops);
    expect(result[0]).toEqual(rest());
    expect(result[1]).toEqual(farm);
    expect(result[2]!.commandKey).toBe('c1');
    // 원본은 바꾸지 않는다.
    expect(latest[0]!.commandKey).toBe('c0');
  });

  it('저장 입력은 표시 이름을 빼고 휴식은 null로 보낸다', () => {
    const turns = [toTurn({ commandKey: 'move', args: { cityKey: 3 }, name: '이동' } as never), rest()];
    expect(toSaveSlots(turns)).toEqual([{ commandKey: 'move', args: { cityKey: 3 } }, null]);
    expect(toTurn({ commandKey: 'rest' })).toEqual(rest());
  });

  it('인자 키 순서가 달라도 같은 명령으로 본다', () => {
    expect(turnKey({ commandKey: 'donate', args: { amount: 1, resource: 'gold' } })).toBe(
      turnKey({ commandKey: 'donate', args: { resource: 'gold', amount: 1 } }),
    );
    expect(sameTurns(empty(), empty())).toBe(true);
  });

  it('전체·홀수·짝수 칸과 반복 가능한 구간', () => {
    expect(quickSelect('all').size).toBe(30);
    expect([...quickSelect('odd')].slice(0, 3)).toEqual([0, 2, 4]);
    expect([...quickSelect('even')].slice(0, 3)).toEqual([1, 3, 5]);
    expect(repeatRange(new Set([1, 2, 3]))).toEqual({ from: 1, to: 3 });
    expect(repeatRange(new Set([1, 3]))).toBeNull();
    expect(repeatRange(new Set([28, 29]))).toBeNull();
    expect(describeSelection(new Set([1, 2, 3, 4, 9]))).toBe('2~5, 10');
  });
});

describe('명령 인자 칸', () => {
  const recruit = {
    type: 'object',
    properties: {
      amount: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
      crewType: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
    },
    required: ['amount', 'crewType'],
  };

  it('JSON Schema에서 칸을 만들고 넣으면 안 되는 인자는 뺀다', () => {
    expect(argFields(recruit).map((f) => [f.key, f.kind])).toEqual([
      ['amount', 'integer'],
      ['crewType', 'integer'],
    ]);
    expect(argFields({ properties: { cityKey: { type: 'integer' } } })[0]!.kind).toBe('city');
    expect(argFields({ properties: { nationId: { not: {} } } })).toEqual([]);
    expect(argFields({ properties: { color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } } })[0]!.kind).toBe(
      'color',
    );
    expect(argFields({ properties: { resource: { type: 'string', enum: ['gold', 'rice'] } } })[0]).toMatchObject({
      kind: 'enum',
      options: [
        { value: 'gold', label: '금' },
        { value: 'rice', label: '쌀' },
      ],
    });
  });

  it('필수 값이 비었거나 범위 밖이면 넣지 않는다', () => {
    const fields = argFields(recruit);
    expect(buildArgs(fields, requiredKeys(recruit), { amount: '100', crewType: '1' })).toEqual({
      args: { amount: 100, crewType: 1 },
      missing: [],
    });
    expect(buildArgs(fields, requiredKeys(recruit), { amount: '0', crewType: '' }).missing).toEqual([
      '수량',
      '병종 번호',
    ]);
    const buy = argFields({ properties: { buy: { type: 'boolean' } } });
    expect(buildArgs(buy, ['buy'], { buy: 'false' }).args).toEqual({ buy: false });
  });

  it('도시·국가는 지도 이름으로 적는다', () => {
    const names = { city: (k: number) => (k === 3 ? '낙양' : undefined), nation: () => undefined };
    expect(describeArgs({ cityKey: 3 }, names)).toBe('낙양');
    expect(describeArgs({ nationId: 9 }, names)).toBe('국가 9');
    expect(describeArgs({ amount: 100, buy: true }, names)).toBe('수량 100 · 쌀 사기');
  });
});

describe('실행 예정 시기', () => {
  const clock = { gameDate: { year: 190, month: 3 }, nowTick: 2 * 600 + 10, msPerTick: 100, turnTermMinutes: 1 };

  it('첫 칸은 nextTurnAt, 다음 칸부터 턴 간격씩 늘고 연월은 한 달씩 넘어간다', () => {
    const now = new Date('2026-10-21T10:00:00');
    const times = slotTimes(3, clock, 2 * 600 + 300, '2026-10-21T10:00:30.000Z', now);
    expect(times.map((t) => t.date)).toEqual(['190년 3월', '190년 4월', '190년 5월']);
    expect(Date.parse(times[1]!.iso!) - Date.parse(times[0]!.iso!)).toBe(60_000);
  });

  it('월드가 멈춰 nextTurnAt이 없으면 시각은 비우고 연월만 보인다', () => {
    const [first] = slotTimes(1, clock, 2 * 600 + 300, null);
    expect(first).toEqual({ date: '190년 3월', time: null, iso: null });
  });
});

describe('초안 보관', () => {
  const store = (value: string | null): Storage =>
    ({ getItem: () => value, setItem: () => undefined, removeItem: () => undefined }) as unknown as Storage;

  it('계정과 월드마다 키가 다르다', () => {
    expect(draftStorageKey('u1', 'w1')).not.toBe(draftStorageKey('u2', 'w1'));
  });

  it('형식이 맞는 초안만 읽고 깨진 값은 버린다', () => {
    const draft = { baseRevision: 3, ops: [{ shift: 1 }], turns: empty() };
    expect(readStored(store(JSON.stringify({ draft, pending: null })), 'k').draft).toEqual(draft);
    expect(readStored(store(JSON.stringify({ draft: { ...draft, turns: [] }, pending: null })), 'k').draft).toBeNull();
    expect(readStored(store('{깨진'), 'k')).toEqual({ draft: null, pending: null });
    expect(readStored(store(JSON.stringify({ draft: null, pending: { ops: [{ bad: 1 }] } })), 'k').pending).toBeNull();
  });
});
