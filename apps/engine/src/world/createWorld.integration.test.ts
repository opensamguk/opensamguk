import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { loadInitialWorldFromDb } from './resources';
import {
  prepareInitialWorld,
  readWorldState,
  saveInitialWorld as persistInitialWorld,
  savePreparedInitialWorld,
} from './persistence';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname))
  throw new Error('pnpm test:int로 전용 테스트 DB를 준비하세요.');
const db = createDb(url);
const options = { name: 'AC-M1-03 integration', turnTermMinutes: 10, endYear: null };
const input = { scenario: '1030', map: 'che', seed: 'integration-seed' };

const ownedWorldIds = new Set<string>();
const ownedCliAuditIds: bigint[] = [];
let failed = false;
async function saveInitialWorld(...args: Parameters<typeof persistInitialWorld>) {
  const result = await persistInitialWorld(...args);
  ownedWorldIds.add(result.worldId);
  return result;
}
beforeEach(() => {
  onTestFailed(() => {
    failed = true;
  });
});
afterAll(async () => {
  const errors: unknown[] = [];
  if (!failed) {
    try {
      await db.world.deleteMany({ where: { id: { in: [...ownedWorldIds] } } });
      // 감사는 삭제가 금지된 이력이며 전용 DB의 최종 정리까지 보존한다.
      const audits = await db.auditLog.findMany({
        where: { id: { in: ownedCliAuditIds } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(audits.map((row) => row.id)).toEqual([...ownedCliAuditIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await db.$disconnect();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, '초기 생성 고정물 정리에 실패했습니다.');
});

describe('AC-M1-03 실제 DB 월드 생성', () => {
  const cliArgs = [
    '--scenario',
    '1030',
    '--map',
    'che',
    '--seed',
    'cli-seed',
    '--turn-term',
    '7',
    '--end-year',
    '300',
    '--name',
    'CLI 통합 검증',
  ];
  const runCli = (args: readonly string[]) =>
    execFileSync(
      process.execPath,
      ['--env-file-if-exists=.env', '--import', 'tsx', 'apps/engine/src/cli/createWorld.ts', ...args],
      {
        cwd: new URL('../../../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

  it('94개 도시·21개 국가·491명·외교 7쌍을 저장하고 재적재 해시가 같다', async () => {
    const state = await loadInitialWorldFromDb(db, input);
    const first = await saveInitialWorld(db, state, options);
    const second = await saveInitialWorld(db, await loadInitialWorldFromDb(db, input), {
      ...options,
      name: '두 번째 월드',
    });
    expect(second.worldId).not.toBe(first.worldId);
    for (const result of [first, second]) {
      const read = await readWorldState(db, result.worldId);
      expect([read.cities.length, read.nations.length, read.generals.length, read.diplomacies.length]).toEqual([
        94, 21, 491, 7,
      ]);
      expect(read).toEqual(state);
      const withPortraits = read.generals.filter((general) => general.portraitId !== null);
      expect(withPortraits.length).toBe(429);
      expect(withPortraits.length / read.generals.length).toBeGreaterThanOrEqual(0.8);
      expect(read.generals.find((general) => general.name === '조조')?.portraitId).toBe(10405);
      expect(read.generals.find((general) => general.name === '고승')?.portraitId).toBeNull();
      expect(hashState(read)).toBe(result.stateHash);
      expect(result.stateHash).toBe(hashState(state));
      const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
      expect(world).toMatchObject({
        status: 'PREOPEN',
        clockTick: 0,
        turnTermMinutes: 10,
        initialStateHash: result.stateHash,
      });
    }
  });

  it('장수 저장이 실패하면 월드·국가·도시도 모두 롤백한다', async () => {
    const state = await loadInitialWorldFromDb(db, input);
    state.generals[0]!.cityKey = 99999;
    const before = await Promise.all([
      db.world.count(),
      db.nation.count(),
      db.city.count(),
      db.general.count(),
      db.diplomacy.count(),
    ]);
    await expect(saveInitialWorld(db, state, options)).rejects.toThrow();
    expect(
      await Promise.all([
        db.world.count(),
        db.nation.count(),
        db.city.count(),
        db.general.count(),
        db.diplomacy.count(),
      ]),
    ).toEqual(before);
  });

  it('잘못된 이름과 턴 간격은 DB에 쓰기 전에 거부한다', async () => {
    const state = await loadInitialWorldFromDb(db, input);
    const before = await db.world.count();
    for (const turnTermMinutes of [0, -1, 0.5, NaN, 2_147_483_648]) {
      await expect(saveInitialWorld(db, state, { ...options, turnTermMinutes })).rejects.toThrow('턴 간격');
    }
    await expect(saveInitialWorld(db, state, { ...options, name: '  ' })).rejects.toThrow('월드 이름');
    for (const endYear of [state.startYear - 1, 10001, 1.5, NaN, undefined]) {
      await expect(saveInitialWorld(db, state, { ...options, endYear: endYear as number })).rejects.toThrow(
        '종료 연도',
      );
    }
    expect(await db.world.count()).toBe(before);
  });

  it('DB 외래키가 다른 월드 국가·도시 참조를 거부한다', async () => {
    const state = await loadInitialWorldFromDb(db, input);
    const a = await saveInitialWorld(db, state, options);
    const b = await saveInitialWorld(db, state, options);
    await db.nation.create({
      data: {
        worldId: b.worldId,
        id: 999,
        name: 'B에만 존재',
        color: '#000000',
        gold: 0,
        rice: 0,
        description: '',
        tech: 0,
        philosophy: '',
        level: 0,
      },
    });
    await expect(
      db.city.update({
        where: { worldId_cityKey: { worldId: a.worldId, cityKey: 1 } },
        data: { nationId: 999 },
      }),
    ).rejects.toThrow();
  });

  it('CLI가 받은 설정을 저장하고 월드 ID와 실제 상태 해시를 출력한다', async () => {
    const output = runCli(cliArgs);
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string; stateHash: string };
    ownedWorldIds.add(result.worldId);
    expect(hashState(await readWorldState(db, result.worldId))).toBe(result.stateHash);
    expect(await db.world.findUniqueOrThrow({ where: { id: result.worldId } })).toMatchObject({
      name: 'CLI 통합 검증',
      turnTermMinutes: 7,
    });
    const audits = await db.auditLog.findMany({ where: { worldId: result.worldId } });
    expect(audits).toHaveLength(1);
    ownedCliAuditIds.push(audits[0]!.id);
    expect(audits[0]).toMatchObject({
      actorKind: 'CLI',
      actorUserId: null,
      action: 'world.create.applied',
      targetType: 'World',
      targetId: result.worldId,
      inputEventId: null,
      payload: { stateHash: result.stateHash },
    });
  });

  it('호출자가 소유한 TX에 예정 UUID로 저장하고 후속 실패면 초기 행을 모두 되돌린다', async () => {
    const initial = await loadInitialWorldFromDb(db, input),
      prepared = prepareInitialWorld(initial, options);
    const firstId = randomUUID();
    const saved = await db.$transaction((tx) => savePreparedInitialWorld(tx, prepared, firstId), { timeout: 30000 });
    ownedWorldIds.add(saved.worldId);
    expect(saved).toEqual({ worldId: firstId, stateHash: hashState(initial) });
    expect(await readWorldState(db, firstId)).toEqual(initial);
    const rolledBackId = randomUUID();
    await expect(
      db.$transaction(
        async (tx) => {
          await savePreparedInitialWorld(tx, prepared, rolledBackId);
          throw new Error('후속 접수 저장 실패');
        },
        { timeout: 30000 },
      ),
    ).rejects.toThrow('후속 접수 저장 실패');
    expect(await db.world.findUnique({ where: { id: rolledBackId } })).toBeNull();
    for (const table of ['Nation', 'City', 'General', 'GeneralTurn', 'Diplomacy', 'NationTurn']) {
      const rows = await db.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "${table}" WHERE "worldId"=$1::text`,
        rolledBackId,
      );
      expect(rows).toEqual([{ count: 0 }]);
    }
    expect(hashState(await readWorldState(db, firstId))).toBe(saved.stateHash);
  });

  it('CLI 생성 감사가 실패하면 기존 게임 행과 감사는 보존하고 새 초기 행은 남기지 않는다', async () => {
    const snapshot = async () => {
      const result: Record<string, string> = {};
      for (const table of [
        'World',
        'Nation',
        'City',
        'General',
        'GeneralTurn',
        'Diplomacy',
        'NationTurn',
        'AuditLog',
      ]) {
        const rows = await db.$queryRawUnsafe<{ rows: string }[]>(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows FROM "${table}" t`,
        );
        result[table] = hashState(rows[0]!.rows);
      }
      return result;
    };
    const before = await snapshot();
    await db.$executeRawUnsafe(
      `CREATE FUNCTION admin_create_a_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='world.create.applied' AND NEW."actorKind"::text='CLI' THEN RAISE EXCEPTION 'CLI_AUDIT_TEST_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    const errors: unknown[] = [];
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER admin_create_a_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION admin_create_a_audit_failure()`,
      );
      let failure: unknown;
      try {
        runCli(cliArgs);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status: 1 });
      const output = failure as { stdout: string; stderr: string };
      expect(`${output.stdout}${output.stderr}`.includes(url!)).toBe(false);
      expect(await snapshot()).toEqual(before);
    } catch (error) {
      errors.push(error);
    }
    for (const sql of [
      'DROP TRIGGER IF EXISTS admin_create_a_audit_failure ON "AuditLog"',
      'DROP FUNCTION admin_create_a_audit_failure()',
    ]) {
      try {
        await db.$executeRawUnsafe(sql);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'CLI 감사 롤백 검증 또는 고정물 정리에 실패했습니다.');
  });

  it('CLI의 필수 인수 누락은 종료 코드 1이고 월드를 쓰지 않는다', async () => {
    const before = await db.world.count();
    let failure: unknown;
    try {
      runCli(cliArgs.slice(0, -2));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('scenario, map, seed, turn-term, end-year, name이 필요합니다.'),
    });
    const { stdout, stderr } = failure as { stdout: string; stderr: string };
    expect(`${stdout}${stderr}`.includes(url!)).toBe(false);
    expect(await db.world.count()).toBe(before);
  });
});
