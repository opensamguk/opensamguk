import { editArray } from '@opensamguk/shared';

// 예턴 편집의 순수 계산. 서버(turns.edit)와 같은 editArray를 써서 화면의 미리보기와 저장 결과가 어긋나지 않게 한다.
// 서버 계약: docs/plans/T1-11.md, apps/server/src/routers/turns.ts.

export const SLOT_COUNT = 30;

export interface Turn {
  commandKey: string;
  args: Record<string, unknown>;
}

// 화면에 모아 둔 편집 하나. 충돌(STALE) 뒤 최신 목록에 같은 순서로 다시 적용한다.
export type EditOp =
  | { put: { indices: number[]; turn: Turn } }
  | { shift: number }
  | { repeat: { from: number; to: number; times: number } };

export const REST: Turn = { commandKey: 'rest', args: {} };
const rest = (): Turn => ({ commandKey: 'rest', args: {} });

// 서버 칸(commandKey·args·name)에서 저장에 쓰는 값만 남긴다. 표시용 name은 저장 입력에 넣지 않는다.
export function toTurn(slot: { commandKey: string; args?: unknown }): Turn {
  const args = typeof slot.args === 'object' && slot.args !== null ? (slot.args as Record<string, unknown>) : {};
  return { commandKey: slot.commandKey, args: { ...args } };
}

// 흩어진 칸 번호를 이어진 구간으로 묶는다. [1,2,3,7] → [[1,3],[7,7]]
export function runs(indices: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < SLOT_COUNT).sort((a, b) => a - b);
  const result: Array<[number, number]> = [];
  for (const i of sorted) {
    const last = result.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else result.push([i, i]);
  }
  return result;
}

export function applyOp(turns: readonly Turn[], op: EditOp): Turn[] {
  if ('put' in op) {
    let next = [...turns];
    for (const [from, to] of runs(op.put.indices))
      next = editArray(next, { put: { from, to, value: op.put.turn } }, rest);
    return next;
  }
  if ('shift' in op) return editArray(turns, { shift: op.shift }, rest);
  return editArray(turns, { repeat: op.repeat }, rest);
}

export function applyOps(turns: readonly Turn[], ops: readonly EditOp[]): Turn[] {
  return ops.reduce<Turn[]>((acc, op) => applyOp(acc, op), [...turns]);
}

// 저장 입력. 휴식은 null로 보낸다 (서버가 휴식으로 채운다).
export function toSaveSlots(turns: readonly Turn[]) {
  return turns.map((turn) => (turn.commandKey === 'rest' ? null : { commandKey: turn.commandKey, args: turn.args }));
}

export function sameTurns(a: readonly Turn[], b: readonly Turn[]): boolean {
  return a.length === b.length && a.every((turn, i) => turnKey(turn) === turnKey(b[i]!));
}

// 같은 명령·인자를 하나로 묶는 키. 인자 키 순서와 상관없이 같게 만든다.
export function turnKey(turn: Turn): string {
  const args = Object.keys(turn.args)
    .sort()
    .map((key) => [key, turn.args[key]]);
  return JSON.stringify([turn.commandKey, args]);
}

// 반복은 이어진 한 구간만 된다. 마지막 칸(30번)이 끝인 구간은 뒤에 붙일 자리가 없다.
export function repeatRange(selected: ReadonlySet<number>): { from: number; to: number } | null {
  const ranges = runs(selected);
  if (ranges.length !== 1) return null;
  const [from, to] = ranges[0]!;
  return to >= SLOT_COUNT - 1 ? null : { from, to };
}

export type QuickSelect = 'all' | 'odd' | 'even';

// 칸 번호는 화면에 1부터 보인다. 홀수 칸은 1·3·5…번(인덱스 0·2·4…)이다.
export function quickSelect(kind: QuickSelect): Set<number> {
  return new Set(
    Array.from({ length: SLOT_COUNT }, (_, i) => i).filter((i) =>
      kind === 'all' ? true : kind === 'odd' ? i % 2 === 0 : i % 2 === 1,
    ),
  );
}

export function rangeBetween(a: number, b: number): number[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// 선택 칸을 짧게 적는다. [1,2,3,4] → "2~5", [0,2] → "1, 3"
export function describeSelection(selected: ReadonlySet<number>): string {
  return runs(selected)
    .map(([from, to]) => (from === to ? `${from + 1}` : `${from + 1}~${to + 1}`))
    .join(', ');
}
