import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { TICKS_PER_MONTH, type LogisticsConfig, type ReplayState, type WorldInit } from '../packages/rules/src/index';
import { governanceTestConfig } from '../packages/rules/src/governance/testFixture';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { initializeResources } from './init-resources';
import { initializeIntegrationResources } from './integration-resources';
import { loadPersonnelTurnContext } from '../apps/engine/src/ruleFeatures';

// AC-P2-30·31·32·33: 정식 명단과 일정에 비공개 시험 설정을 더한 첫 달이다. 공개 프로필·전체 기수 인수는 아니다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('확장 결합 전용 테스트 DB가 필요합니다.');
const target = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname) ||
  target.searchParams.has('host') ||
  target.searchParams.has('port')
)
  throw new Error('loopback 전용 테스트 DB를 확인하세요.');
let db = createDb(url);
const ids: string[] = [];
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'governance-v1',
  'heritage-v1',
  'lineage-v1',
  'logistics-v1',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
];

describe('AC-P2-30·31·32·33 정식 491명 확장 결합', () => {
  let worldId: string;
  let before: ReplayState;
  let preparation: Promise<void> | undefined;
  let execution: Promise<void> | undefined;
  beforeAll(() => {
    preparation = (async () => {
      await initializeResources(
        db,
        await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
      );
      await initializeIntegrationResources(db);
      const initial = await loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'expanded-native-first-month',
      });
      expect(initial.generals).toHaveLength(491);
      expect(initial.nations).toHaveLength(21);
      expect(initial.cities).toHaveLength(61);
      const native = structuredClone(initial);
      initial.ruleFeatures = [...features];
      const supplied = structuredClone(initial);
      const city = initial.cities.find(
        (row) =>
          row.kind !== 'PASS' &&
          row.nationId !== null &&
          row.supplied &&
          row.population > 0 &&
          row.populationMax > 0 &&
          initial.cities.some(
            (other) =>
              row.connections.includes(other.cityKey) &&
              other.kind !== 'PASS' &&
              other.nationId === row.nationId &&
              other.supplied,
          ),
      );
      if (!city) throw new Error('정식 명단의 생산 가능한 특산 고정물이 없습니다.');
      // 기존 물류 저장 시험의 설정만 재사용한다. 명단·외교·병력·차례는 바꾸지 않는다.
      const logistics: LogisticsConfig = {
        version: 1,
        specialties: [{ cityKey: city.cityKey, good: 'iron', perMonth: 1000 }],
        capacity: { base: 10_000, perLevel: 10_000, maxLevel: 5 },
        upgrade: { gold: 1000, wood: 500 },
        transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 10_000, maxActivePerNation: 20 },
        recruitPer100: Object.fromEntries(
          [...new Set(initial.unitSet.crewTypes.filter((type) => type.armType > 0).map((type) => type.armType))].map(
            (armType) => [String(armType), { iron: 2, wood: 0, horses: 0 }],
          ),
        ),
        build: { wall: { iron: 0, wood: 50, horses: 0 }, defence: { iron: 20, wood: 20, horses: 0 } },
        trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
      };
      ({ worldId } = await saveInitialWorld(db, initial, {
        name: '정식 명단 확장 결합 시험',
        turnTermMinutes: 60,
        endYear: 201,
        replayFormat: 3,
        ruleFeatures: [...features],
        featureData: {
          'logistics-v1': logistics,
          'governance-v1': governanceTestConfig,
          'lineage-v1': lineageTestConfig,
          'heritage-v1': { version: 1 },
        },
      }));
      ids.push(worldId);
      expect(initial).toEqual(supplied);
      const stored = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      const origin = stored.replayOrigin as unknown as { initial: WorldInit; featureData: Record<string, unknown> };
      expect(origin.initial).toEqual({ ...native, ruleFeatures: features, generals: origin.initial.generals });
      expect(
        origin.initial.generals.map((general) => {
          const unchanged = { ...general };
          delete unchanged.sex;
          return unchanged;
        }),
      ).toEqual(native.generals);
      expect(stored.initialStateHash).toBe(hashState(origin.initial));
      expect(origin.featureData['heritage-v1']).toEqual({ version: 1 });
      expect(stored.ruleFeatures).toEqual(features);
      before = await db.$transaction((tx) => loadReplayState(tx, worldId));
      expect(Object.keys(before.state.generals)).toHaveLength(491);
      expect(Object.values(before.state.generals).filter((general) => general.sex === 'UNKNOWN')).toHaveLength(477);
      expect(before.state.lineage?.persons).toEqual({});
      expect(before.state.lineage?.config).toEqual(lineageTestConfig);
      expect(before.state.logistics?.config).toEqual(logistics);
      expect(before.state.governance?.config).toEqual(governanceTestConfig);
      expect(Object.keys(before.state.governance!.legitimacy).sort()).toEqual(Object.keys(before.state.nations).sort());
      expect(await db.heritageEntry.count({ where: { worldId } })).toBe(0);
    })();
    return preparation;
  });
  beforeEach(async () => {
    await execution?.catch(() => undefined);
  });
  afterAll(async () => {
    try {
      await preparation?.catch(() => undefined);
      await execution?.catch(() => undefined);
      await db.world.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await db.$disconnect();
    }
  });

  it('원래 NPC 차례를 진행해 첫 달 확장 상태와 연감을 함께 저장한다', () => {
    execution = (async () => {
      await controlClock(db, worldId, 'start');
      const lease = await acquireLease(db, worldId);
      if (!lease) throw new Error('확장 결합 시험 실행권이 없습니다.');
      try {
        const loop = new TurnLoop(db, lease);
        for (let tick = 1000; tick <= TICKS_PER_MONTH; tick += 1000) {
          await renewLease(db, lease);
          await loop.advanceTo(tick);
        }
      } finally {
        await releaseLease(db, lease);
      }
      const after = await db.$transaction((tx) => loadReplayState(tx, worldId));
      expect(after.monthlyTick).toBe(TICKS_PER_MONTH);
      expect(after.state.logistics?.monthlyTick).toBe(TICKS_PER_MONTH);
      expect(after.state.governance?.monthlyTick).toBe(TICKS_PER_MONTH);
      expect(after.state.lineage?.monthlyTick).toBe(TICKS_PER_MONTH);
      expect(await db.yearbookSnapshot.count({ where: { worldId, tick: TICKS_PER_MONTH } })).toBe(1);
      expect(hashState(after)).not.toBe(hashState(before));
    })();
    return execution;
  }, 60_000);

  it('새 DB 연결에서 전체 상태·생산 원장·국가별 황실 상태를 보존한다', () => {
    execution = (async () => {
      const final = await db.$transaction((tx) => loadReplayState(tx, worldId));
      await db.$disconnect();
      db = createDb(url);
      const reloaded = await db.$transaction((tx) => loadReplayState(tx, worldId));
      expect(reloaded).toEqual(final);
      const movements = await db.logisticsMovement.findMany({
        where: { worldId },
        orderBy: [{ sequence: 'asc' }, { ordinal: 'asc' }],
      });
      expect(movements.some((row) => row.reason === 'PRODUCE' && row.delta > 0)).toBe(true);
      for (const [key, stock] of Object.entries(reloaded.state.logistics!.cities))
        for (const good of ['iron', 'wood', 'horses'] as const) {
          const delta = movements
            .filter((row) => row.holder === 'city' && row.holderId === Number(key) && row.good === good)
            .reduce((sum, row) => sum + row.delta, 0);
          expect(stock[good]).toBe(before.state.logistics!.cities[key]![good] + delta);
        }
      expect(Object.keys(reloaded.state.governance!.legitimacy).sort()).toEqual(
        Object.keys(reloaded.state.nations).sort(),
      );
      expect(reloaded.state.governance!.revision).toBeGreaterThan(before.state.governance!.revision);
      expect(await db.general.count({ where: { worldId, userId: { not: null } } })).toBe(0);
      expect(await db.heritageEntry.count({ where: { worldId } })).toBe(0);
    })();
    return execution;
  });

  it('13기능을 원생성부터 실제 재생해 첫 달의 정확한 tick·sequence·해시를 대조한다', () => {
    execution = (async () => {
      const month = await db.yearbookSnapshot.findUniqueOrThrow({
        where: { worldId_tick: { worldId, tick: TICKS_PER_MONTH } },
      });
      const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      const final = await db.$transaction((tx) => loadReplayState(tx, worldId));
      expect(replayArchive(await exportReplay(db, worldId), 1)).toEqual([
        { tick: month.tick, stateHash: month.stateHash },
      ]);
      if (world.actionSequence === month.sequence) expect(month.stateHash).toBe(hashState(final));
      expect(await db.$transaction((tx) => loadReplayState(tx, worldId))).toEqual(final);
    })();
    return execution;
  });
});

describe('AC-P2-30·31·32·33 차례 인사 문맥의 전역 무결성', () => {
  const owned: string[] = [],
    users: string[] = [];
  let execution: Promise<void> | undefined;
  beforeAll(() => {
    db = createDb(url);
  });
  beforeEach(async () => {
    await execution?.catch(() => undefined);
  });
  afterAll(async () => {
    try {
      await execution?.catch(() => undefined);
      await db.world.deleteMany({ where: { id: { in: owned } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  });
  async function fixture() {
    const initial = commandInitial();
    initial.ruleFeatures = ['personnel', 'policy'];
    const saved = await saveInitialWorld(db, initial, {
      name: '인사 문맥 무결성 고정물',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: initial.ruleFeatures,
    });
    owned.push(saved.worldId);
    await controlClock(db, saved.worldId, 'start');
    return saved.worldId;
  }
  async function preserved(worldId: string) {
    return {
      world: await db.world.findUniqueOrThrow({ where: { id: worldId } }),
      generals: await db.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      turns: await db.generalTurn.findMany({ where: { worldId }, orderBy: [{ generalId: 'asc' }, { slot: 'asc' }] }),
      logs: await db.generalLog.findMany({ where: { worldId }, orderBy: { id: 'asc' } }),
      months: await db.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } }),
    };
  }
  async function advance(worldId: string) {
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('인사 문맥 시험 실행권이 없습니다.');
    try {
      await new TurnLoop(db, lease).advanceTo(100);
    } finally {
      await releaseLease(db, lease);
    }
  }
  it('실제 정수 배열 조회의 문맥은 완전 재생 조회의 소비 필드와 같다', () => {
    execution = (async () => {
      const worldId = await fixture();
      await db.$transaction(async (tx) => {
        const replay = await loadReplayState(tx, worldId);
        expect(await loadPersonnelTurnContext(tx, worldId, replay.state)).toEqual({
          state: replay.state,
          offices: replay.offices,
          residenceAnchors: replay.residenceAnchors,
        });
      });
      await advance(worldId);
      expect(
        (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).nextTurnTick,
      ).toBeGreaterThan(100);
    })();
    return execution;
  });
  it.each(['missing-slot', 'no-slots', 'null-policy', 'null-activity', 'slot-before-policy'] as const)(
    '%s는 다른 장수의 차례 전에도 거부하고 상태와 예약·기록을 보존한다',
    (kind) => {
      execution = (async () => {
        const worldId = await fixture();
        if (kind === 'missing-slot' || kind === 'slot-before-policy')
          await db.generalTurn.delete({ where: { worldId_generalId_slot: { worldId, generalId: 2, slot: 29 } } });
        if (kind === 'no-slots') await db.generalTurn.deleteMany({ where: { worldId, generalId: 2 } });
        if (kind === 'null-policy' || kind === 'slot-before-policy')
          await db.general.update({
            where: { worldId_id: { worldId, id: kind === 'null-policy' ? 2 : 1 } },
            data: { defaultPolicy: null },
          });
        if (kind === 'null-activity') {
          const id = randomUUID();
          users.push(id);
          await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'not-a-login-hash' } });
          await db.general.update({
            where: { worldId_id: { worldId, id: 1 } },
            data: { userId: id, lastActiveTick: null, residenceTick: 0 },
          });
        }
        const before = await preserved(worldId);
        const message =
          kind === 'null-policy'
            ? '저장된 기본 방침이 올바르지 않습니다.'
            : kind === 'null-activity'
              ? '사람 장수의 활동 tick이 없습니다.'
              : '예턴 칸은 0부터 29까지 한 칸씩 있어야 합니다.';
        await expect(advance(worldId)).rejects.toThrow(message);
        expect(await preserved(worldId)).toEqual(before);
      })();
      return execution;
    },
  );
  it('같은 장수 ID가 있는 다른 월드의 손상된 예약은 섞지 않는다', () => {
    execution = (async () => {
      const worldId = await fixture(),
        otherId = await fixture();
      await db.generalTurn.deleteMany({ where: { worldId: otherId, generalId: 2 } });
      const otherBefore = await preserved(otherId);
      await advance(worldId);
      expect(
        (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } })).nextTurnTick,
      ).toBeGreaterThan(100);
      expect(await preserved(otherId)).toEqual(otherBefore);
    })();
    return execution;
  });
});
