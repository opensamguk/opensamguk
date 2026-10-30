import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { investigationFootprint, settleInvestigationRenewals } from '../e2e/investigationObservation';

function pending() {
  let resolve!: () => void;
  const renewal = new Promise<void>((done) => {
    resolve = done;
  });
  return { done: new AbortController(), renewal, resolve };
}

describe('AC-M3-05 조사 비교 전 자기 고정물 갱신의 정착', () => {
  it('모든 갱신을 먼저 중단하고 마지막 진행 작업까지 기다린 뒤 본문으로 넘긴다', async () => {
    const first = pending(),
      second = pending();
    let settled = false;
    const result = settleInvestigationRenewals([first, second]).then(() => {
      settled = true;
    });
    expect(first.done.signal.aborted && second.done.signal.aborted).toBe(true);
    first.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await result;
    expect(settled).toBe(true);
  });

  it('이미 잃은 리스나 거부된 갱신은 성공으로 넘기지 않는다', async () => {
    const lost = new Error('lease lost');
    await expect(
      settleInvestigationRenewals([{ done: new AbortController(), renewal: Promise.resolve(), lost }]),
    ).rejects.toMatchObject({ errors: [lost] });
    await expect(
      settleInvestigationRenewals([{ done: new AbortController(), renewal: Promise.reject(lost) }]),
    ).rejects.toMatchObject({ errors: [lost] });
  });

  it('한 갱신이 실패해도 나머지 진행 작업의 정착을 먼저 기다린다', async () => {
    const other = pending(),
      lost = new Error('lease lost');
    let settled = false;
    const result = settleInvestigationRenewals([
      { done: new AbortController(), renewal: Promise.reject(lost) },
      other,
    ]).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(other.done.signal.aborted).toBe(true);
    other.resolve();
    expect(await result).toMatchObject({ errors: [lost] });
  });
});

describe('AC-M3-05 전체 행 footprint와 비밀값 없는 차이', () => {
  const rows = [
    { table: 'EngineLease', body: '[{"expiresAt":"2026-10-30T00:00:00Z","fencingToken":1}]' },
    { table: 'Session', body: '[{"id":"private-session-value","expiresAt":"2026-11-30T00:00:00Z"}]' },
    { table: 'World', body: '[{"actionSequence":1,"clockTick":0}]' },
  ];
  const take = (input = rows) => {
    const fingerprint = investigationFootprint();
    for (const row of input) fingerprint.table(row.table, row.body);
    return fingerprint.finish();
  };

  it('이전 전체 테이블 이름·본문 해시와 정확히 같고 원문 행은 진단에 넣지 않는다', () => {
    const previous = createHash('sha256');
    for (const row of rows) previous.update(row.table + ':' + row.body + '\n');
    const result = take();
    expect(result.hash).toBe(previous.digest('hex'));
    expect(result.tables.map(({ table }) => table)).toEqual(['EngineLease', 'Session', 'World']);
    expect(JSON.stringify(result)).not.toContain('private-session-value');
    expect(JSON.stringify(result)).not.toContain('2026-11-30');
  });

  it('리스 만료·세션·게임 sequence 어느 필드의 변화도 숨기지 않는다', () => {
    const before = take();
    for (const [index, body] of [
      [0, rows[0]!.body.replace('00:00:00Z', '00:00:05Z')],
      [1, rows[1]!.body.replace('private-session-value', 'changed-session-value')],
      [2, rows[2]!.body.replace('"actionSequence":1', '"actionSequence":2')],
    ] as const) {
      const after = take(rows.map((row, position) => (position === index ? { ...row, body } : row)));
      expect(after.hash).not.toBe(before.hash);
      expect(after.tables.filter((row, position) => row.sha256 !== before.tables[position]!.sha256)).toEqual([
        after.tables[index],
      ]);
    }
  });

  it('테이블 삭제나 추가도 전체 비교에 남는다', () => {
    expect(take(rows.slice(1))).not.toEqual(take());
    expect(take([...rows, { table: 'InputEvent', body: '[]' }])).not.toEqual(take());
  });
});
