import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import * as rules from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { exportReplay, replayArchive, replayToEnd, type ReplayArchive, type ReplayArchiveV2 } from './replay';
import { loadReplayState } from './monthly';
import { endYearArchive, recordedArchive, rejectedInput, unifiedArchive } from '../test/replayFixture';
import { monthlyFixture } from '../test/monthlyFixture';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const golden = async (): Promise<ReplayArchive> =>
  JSON.parse(await readFile(new URL('../test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'));
const asV2 = (archive: ReplayArchive): ReplayArchiveV2 => ({
  ...archive,
  version: 2,
  config: { endYear: null, outcomeFromSequence: 0 },
  end: null,
  afterEnd: [],
});

afterEach(() => vi.restoreAllMocks());

describe('T1-26 재생 보관 형식', () => {
  it('b8f5074의 v1 골든 12개월을 저장된 해시 그대로 검증한다', async () => {
    const archive = await golden();
    expect(archive.origin.initial.generals.every((general) => general.userId === null)).toBe(true);
    expect(replayArchive(archive)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(archive.months.at(-1)!.stateHash).toBe('d60ad5f09185a889fc64926efe4e367e1b909710b227e76e3005698e71d80a0b');
  });

  it('종료 기록 없는 v2를 JSON으로 주고받아도 v1의 월간 해시와 같다', async () => {
    const archive = await golden();
    expect(replayArchive(roundTrip(asV2(archive)))).toEqual(replayArchive(archive));
  });

  it.each([0, 3, -1, '2', null])('알 수 없는 archive 버전 %s를 거부한다', async (version) => {
    const archive = await golden();
    expect(() => replayArchive({ ...archive, version }, 1)).toThrow();
  });

  it('origin 버전과 v1·v2 혼합 키를 거부한다', async () => {
    const archive = await golden();
    for (const originVersion of [0, 2, undefined]) {
      for (const value of [archive, asV2(archive)]) {
        expect(() => replayArchive({ ...value, origin: { ...value.origin, version: originVersion } }, 1)).toThrow(
          '버전',
        );
      }
    }
    for (const key of ['config', 'end', 'afterEnd']) {
      expect(() => replayArchive({ ...archive, [key]: undefined }, 1)).toThrow('버전');
      const v2: Record<string, unknown> = { ...asV2(archive) };
      delete v2[key];
      expect(() => replayArchive(v2, 1)).toThrow('버전');
    }
  });

  it('v2 설정·입력 순서·끝 번호를 검사한다', async () => {
    const archive = asV2(await golden());
    for (const config of [
      null,
      {},
      { endYear: undefined, outcomeFromSequence: 0 },
      { endYear: null, outcomeFromSequence: -1 },
      { endYear: 10001, outcomeFromSequence: 0 },
    ]) {
      expect(() => replayArchive({ ...archive, config }, 1)).toThrow();
    }
    for (const inputs of [
      [rejectedInput(0)],
      [rejectedInput(2), rejectedInput(1)],
      [rejectedInput(1), rejectedInput(1)],
      [{ ...rejectedInput(1), status: 'PENDING' }],
    ]) {
      expect(() => replayArchive({ ...archive, inputs }, 1)).toThrow('순서');
    }
    const ended = await unifiedArchive();
    ended.inputs.push(rejectedInput(ended.end!.sequence + 1));
    expect(() => replayToEnd(ended)).toThrow('입력');
  });

  it('v1은 종료 판정을 하지 않고 v2는 cutoff 이후 사건부터 판정한다', async () => {
    const initial = await monthlyFixture();
    initial.nations = initial.nations.slice(0, 1);
    initial.cities.forEach((city) => {
      city.nationId = 1;
    });
    initial.generals.forEach((general) => {
      general.nationId = 1;
    });
    initial.diplomacies = [];
    const v2 = recordedArchive(initial, 3);
    const v1: ReplayArchive = { version: 1, origin: v2.origin, inputs: v2.inputs, months: v2.months };
    expect(replayArchive(v1, 1)).toHaveLength(1);
    expect(() => replayArchive(v2, 1)).toThrow('먼저');
    v2.config.outcomeFromSequence = 3;
    expect(replayArchive(v2, 1)).toHaveLength(1);
    const ended = recordedArchive(initial, 4, [], 'UNIFIED');
    ended.config.outcomeFromSequence = 3;
    expect(replayToEnd(ended)).toEqual(ended.end);
    ended.config.outcomeFromSequence = 4;
    expect(() => replayToEnd(ended)).toThrow('종료 사건');
  });

  it('v2 월간 재생도 요청한 개월까지만 검사한다', async () => {
    const archive = await endYearArchive();
    archive.months[5]!.stateHash = '나중 달의 손상';
    archive.end!.finalStateHash = '나중 종료의 손상';
    expect(replayArchive(archive, 1)).toHaveLength(1);
    expect(() => replayArchive(archive, 6)).toThrow('해시');
    const withoutEnd = asV2(await golden());
    withoutEnd.config.endYear = withoutEnd.origin.initial.startYear;
    expect(replayArchive(withoutEnd, 11)).toHaveLength(11);
    expect(() => replayArchive(withoutEnd, 12)).toThrow('먼저');
  });

  it('v2 월간 번호는 DB Int 범위이며 v1의 1천만 상한은 보존한다', async () => {
    const legacy = await golden();
    legacy.months[0]!.sequence = 10_000_001;
    expect(() => replayArchive(legacy, 1)).toThrow('경계');
    for (const sequence of [10_000_001, 2_147_483_647]) {
      const current = asV2(await golden());
      current.months[0]!.sequence = sequence;
      expect(() => replayArchive(current, 1)).toThrow('정산 순서');
    }
  });

  it('v2 종료 번호는 1천만을 넘어도 유효하며 DB Int 초과만 거부한다', async () => {
    const archive = await unifiedArchive();
    for (const sequence of [10_000_001, 2_147_483_647]) {
      archive.end!.sequence = sequence;
      // 번호 형식은 통과하지만 실제 통일은 더 이른 두 번째 사건이므로 즉시 거부한다.
      expect(() => replayToEnd(archive)).toThrow('먼저 끝났습니다');
    }
    archive.end!.sequence = 2_147_483_648;
    expect(() => replayToEnd(archive)).toThrow('재생 설정');
  });

  it('v2 종료 재생의 월간 경계도 1천만 이후 번호를 형식 오류로 거부하지 않는다', async () => {
    const archive = await endYearArchive();
    archive.months[0]!.sequence = 10_000_001;
    archive.end!.sequence = 2_147_483_647;
    expect(() => replayToEnd(archive)).toThrow('정산 순서');
  });
});

describe('T1-26 종료 재생', () => {
  it.each([false, true])('마지막 도시를 얻은 턴에서 끝난다. 정산 뒤 입력: %s', async (afterMonth) => {
    const archive = await unifiedArchive(afterMonth);
    expect(archive.months).toHaveLength(afterMonth ? 1 : 0);
    expect(archive.end).toMatchObject({
      sequence: afterMonth ? 5 : 2,
      tick: afterMonth ? 10100 : 100,
      reason: 'UNIFIED',
      winnerNationId: 1,
      year: 191,
      month: afterMonth ? 2 : 1,
    });
    const next = vi.spyOn(rules, 'nextGameAction');
    const run = vi.spyOn(rules, 'runReplayAction');
    expect(replayToEnd(roundTrip(archive))).toEqual(archive.end);
    expect(next).toHaveBeenCalledTimes(archive.end!.sequence - archive.inputs.length);
    expect(run).toHaveBeenCalledTimes(archive.end!.sequence - archive.inputs.length);
    if (afterMonth) {
      expect(replayArchive(archive, 1)).toHaveLength(1);
      for (let i = 0; i < archive.inputs.length; i++) {
        const missing = roundTrip(archive);
        missing.inputs.splice(i, 1);
        expect(() => replayToEnd(missing)).toThrow();
      }
    }
  });

  it('12월 정산 해시로 끝내고 같은 tick 장수 턴이나 다음 정산을 실행하지 않는다', async () => {
    const archive = await endYearArchive();
    const end = archive.end!;
    expect(end).toMatchObject({
      sequence: 34,
      tick: 120000,
      reason: 'END_YEAR',
      winnerNationId: null,
      year: archive.origin.initial.startYear,
      month: 12,
    });
    expect(end.finalStateHash).toBe(archive.months[11]!.stateHash);
    const run = vi.spyOn(rules, 'runReplayAction');
    expect(replayToEnd(roundTrip(archive))).toEqual(end);
    expect(run).toHaveBeenCalledTimes(34);
    expect(replayArchive(archive, 12)).toHaveLength(12);
  });

  it('종료 뒤 REJECTED는 오름차순·끝 번호 초과만 검사하고 적용하지 않는다', async () => {
    const archive = await unifiedArchive();
    archive.afterEnd = [rejectedInput(5), rejectedInput(9)];
    archive.afterEnd[0]!.kind = '적용하면 실패하는 종류';
    const apply = vi.spyOn(rules, 'applyRecordedInput');
    expect(replayToEnd(archive)).toEqual(archive.end);
    expect(apply).toHaveBeenCalledTimes(archive.inputs.length);
    for (const afterEnd of [
      [rejectedInput(2)],
      [rejectedInput(1)],
      [rejectedInput(4), rejectedInput(3)],
      [rejectedInput(3), rejectedInput(3)],
      [{ ...rejectedInput(3), status: 'APPLIED' }],
    ]) {
      expect(() => replayToEnd({ ...archive, afterEnd })).toThrow('종료 뒤 입력');
    }
    const ongoing = asV2(await golden());
    ongoing.afterEnd = [rejectedInput(100)];
    expect(() => replayArchive(ongoing, 1)).toThrow('종료 뒤 입력');
  });

  it('tick·연월·사유·승자·해시·sequence 변조와 입력 번호의 종료를 거부한다', async () => {
    const archive = await unifiedArchive();
    for (const patch of [
      { tick: 101 },
      { year: 181 },
      { month: 12 },
      { reason: 'END_YEAR', winnerNationId: null },
      { winnerNationId: 2 },
      { finalStateHash: '변조' },
      { sequence: 3 },
    ]) {
      expect(() => replayToEnd({ ...archive, end: { ...archive.end, ...patch } })).toThrow();
    }
    const inputEnd = roundTrip(archive);
    inputEnd.inputs.push(rejectedInput(inputEnd.end!.sequence));
    expect(() => replayToEnd(inputEnd)).toThrow('게임 사건');
    const yearEnd = await endYearArchive();
    yearEnd.config.endYear = null;
    expect(() => replayToEnd(yearEnd)).toThrow('종료 사건');
    const ongoing = asV2(await golden());
    expect(() => replayToEnd(ongoing)).toThrow('종료 기록');
    expect(() => replayToEnd({ ...archive, version: 1 })).toThrow();
  });

  it('월간 기록 누락·추가·순서·경계·연감 변조를 거부한다', async () => {
    const archive = await endYearArchive();
    for (const mutate of [
      (value: ReplayArchiveV2) => {
        value.months.splice(2, 1);
      },
      (value: ReplayArchiveV2) => {
        value.months.push({ ...value.months.at(-1)!, sequence: 35 });
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.sequence++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.tick++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.year++;
      },
      (value: ReplayArchiveV2) => {
        value.months[0]!.data.nations = [];
      },
    ]) {
      const bad = roundTrip(archive);
      mutate(bad);
      expect(() => replayToEnd(bad)).toThrow();
    }
  });
});

function exportDatabase(archive: ReplayArchiveV2, ended = true) {
  const end = archive.end;
  const events = [...archive.inputs, ...archive.afterEnd];
  const tx = {
    world: { findUniqueOrThrow: vi.fn(async () => ({ replayOrigin: archive.origin, ...archive.config })) },
    worldResult: {
      findUnique: vi.fn(async () =>
        ended && end
          ? { ...end, endedSequence: end.sequence, endedTick: end.tick, endedYear: end.year, endedMonth: end.month }
          : null,
      ),
    },
    yearbookSnapshot: { findMany: vi.fn(async () => archive.months) },
    inputEvent: {
      findMany: vi.fn(async ({ where }: { where: { sequence: { lte?: number; not?: null } } }) =>
        events.filter((event) => where.sequence.lte === undefined || event.sequence <= where.sequence.lte),
      ),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  return { tx, db: { $transaction: transaction } as unknown as PrismaClient, transaction, events };
}

describe('T1-26 내보내기와 네 키 상태', () => {
  it.each([false, true])('WorldResult의 끝 번호까지 입력을 내보낸다. 정산 뒤: %s', async (afterMonth) => {
    const expected = await unifiedArchive(afterMonth);
    expected.afterEnd = [rejectedInput(expected.end!.sequence + 1)];
    const { db, tx, transaction } = exportDatabase(expected);
    const archive = roundTrip(await exportReplay(db, 'replay-world'));
    expect(archive).toEqual(expected);
    expect(archive.origin.version).toBe(1);
    expect(tx.worldResult.findUnique).toHaveBeenCalledWith({ where: { worldId: 'replay-world' } });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(replayToEnd(archive)).toEqual(expected.end);
  });

  it('결과가 없으면 마지막 정산 번호까지만 내보낸다', async () => {
    const expected = asV2(await golden());
    const { db, tx, events } = exportDatabase(expected, false);
    events.push(rejectedInput(expected.months.at(-1)!.sequence + 1));
    const archive = roundTrip(await exportReplay(db, 'ongoing'));
    expect(archive).toEqual(expected);
    expect(tx.inputEvent.findMany).toHaveBeenCalledWith({
      where: { worldId: 'ongoing', sequence: { lte: expected.months.at(-1)!.sequence } },
      orderBy: { sequence: 'asc' },
    });
    expect(replayArchive(archive)).toHaveLength(12);
  });

  it('진행 중 첫 정산 전에는 입력을 내보내지 않는다', async () => {
    const expected = recordedArchive(await monthlyFixture(), 0);
    const { db, events } = exportDatabase(expected, false);
    events.push(rejectedInput(1));
    expect(await exportReplay(db, 'new')).toEqual(expected);
  });

  it('종료 뒤 APPLIED와 없는 origin을 내보내지 않는다', async () => {
    const expected = await unifiedArchive();
    expected.afterEnd = [{ ...rejectedInput(3), status: 'APPLIED' }];
    const { db } = exportDatabase(expected);
    await expect(exportReplay(db, 'invalid')).rejects.toThrow('종료 뒤');
    const missing = exportDatabase(expected);
    missing.tx.world.findUniqueOrThrow.mockResolvedValueOnce({ replayOrigin: null, ...expected.config } as never);
    await expect(exportReplay(missing.db, 'missing')).rejects.toThrow('생성 기록');
  });

  it('initialReplayState와 loadReplayState는 네 키를 그대로 반환한다', async () => {
    const initial = await monthlyFixture();
    const expected = rules.initialReplayState(initial);
    const worldId = 'shape-test';
    const withWorld = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row, worldId }));
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?').trim().replace(/\s+/g, ' ');
        if (
          sql === 'SELECT "key", "value" FROM "WorldExtSlice" WHERE "worldId" = ? ORDER BY "key"' &&
          values.length === 1 &&
          values[0] === worldId
        )
          return [];
        throw new Error(`예상하지 않은 원시 조회: ${sql}`);
      },
      world: {
        findUniqueOrThrow: async () => ({
          id: worldId,
          preset: null,
          treatyFormat: null,
          replayOrigin: null,
          policyFromSequence: null,
          actionSequence: 0,
          turnTermMinutes: 30,
          startYear: initial.startYear,
          monthlyTick: 0,
          endYear: initial.startYear,
          clockMode: 'ACCELERATED',
          outcomeFromSequence: 77,
          commandMeta: null,
        }),
      },
      treaty: {
        findMany: async ({ where }: Prisma.TreatyFindManyArgs) => {
          if (where?.worldId !== worldId) throw new Error('예상하지 않은 조약 월드 조회입니다.');
          return [];
        },
      },
      city: { findMany: async () => withWorld(initial.cities) },
      nation: { findMany: async () => withWorld(initial.nations) },
      general: {
        findMany: async () =>
          withWorld(initial.generals).map((general) => ({ ...general, turnRevision: 0, battleWins: 0, captures: 0 })),
      },
      diplomacy: { findMany: async () => withWorld(initial.diplomacies) },
      generalTurn: { findMany: async () => [] },
      nationTurn: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;
    const loaded = await loadReplayState(tx, worldId);
    for (const replay of [expected, loaded]) {
      expect(Object.keys(replay).sort()).toEqual(['monthlyTick', 'revisions', 'state', 'turns']);
      expect(replay).toEqual(expected);
      expect(hashState(replay)).toBe(hashState(expected));
    }
  });
});
