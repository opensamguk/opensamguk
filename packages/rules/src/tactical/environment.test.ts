import { describe, it, expect } from 'vitest';
import { tacticalFrameSchema, battleCouncilInputSchema, type TacticalEvent } from '@opensamguk/shared';
import { tacticalFixture, testUnits } from '../../test/tacticalFixture';
import {
  canIgnite,
  ignite,
  movementCost,
  resolveFire,
  updateWeather,
  visionRange,
  terrainDefense,
} from './environment';
import { closeCouncil, recordBattleFrame, resolveBattleTurn, battleStateHash, visibleTo } from './battle';
import { tacticalBattleSchema, tacticalView } from './state';
import { applyBattleInput } from './input';
import { settleTacticalBattle, openTacticalBattle } from './world';
import { operationalFixture } from '../../test/operationalMapFixture';
import { buildSupplyLedger, verifySupplyLedger } from '../campaign/supply';
import { operationalMapSchema } from '../world/map/operational';

describe('AC-INT-28 야전 칸·날씨·불·시야', () => {
  it('D-105 기상·지물·불을 포함하는 3턴 재생 골든을 고정한다', () => {
    let b = tacticalFixture().battle;
    closeCouncil(b);
    b.weather = 'clear';
    b.wind = 'E';
    b.schemes = [{ kind: 'fire', side: 'attack', turn: 1, x: 0, y: 0, used: false }];
    const hashes = [battleStateHash(b)];
    for (let i = 0; i < 3; i++) {
      b = resolveBattleTurn(
        b,
        b.units.map((u) => ({ unitId: u.id, action: { kind: 'hold' } })),
        testUnits,
      );
      hashes.push(battleStateHash(b));
    }
    expect(hashes).toEqual(['b8237e10f92d6adb', '6cfb98ea30bba966', '97d2f492a046f89d', '042a0aa2a9b89a04']);
  });

  it('화계 예약은 참모·지형·호우·자료 없는 좌표를 검증한다', () => {
    const { world, battle: b } = tacticalFixture();
    b.weather = 'clear';
    const input = {
      worldId: 'world',
      battleId: b.id,
      expectedRevision: b.revision,
      windowNo: b.windowNo,
      mapHash: b.mapHash,
      idempotencyKey: 'fire',
      ready: false,
      schemes: [{ kind: 'fire', turn: 1, x: 3, y: 0 }],
    };
    expect(applyBattleInput(world, 'battle.council', input, 1).ok).toBe(true);
    b.sides.attack.advisorId = null;
    expect(applyBattleInput(world, 'battle.council', input, 1)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    b.sides.attack.advisorId = 1;
    b.weather = 'downpour';
    expect(applyBattleInput(world, 'battle.council', input, 1)).toMatchObject({ ok: false, code: 'BAD_TERRAIN' });
    b.weather = 'clear';
    b.board.terrain[3] = 'river';
    expect(applyBattleInput(world, 'battle.council', input, 1)).toMatchObject({ ok: false, code: 'BAD_TERRAIN' });
    b.board.terrain[3] = 'plain';
    b.cells[3]!.sourceTileId = '';
    expect(applyBattleInput(world, 'battle.council', input, 1)).toMatchObject({ ok: false, code: 'BAD_INPUT' });
  });
  it('지도 자료의 야전 칸을 생성 원장에 고정하고 중복·범위 밖 좌표를 거절한다', () => {
    const map = operationalFixture();
    const plain = buildSupplyLedger(map);
    const cell = plain.routes[0]!.segments[0]!.cells[1]!;
    const feature = {
      x: Math.round(cell.x / 16),
      y: Math.round(cell.y / 16),
      terrain: 'sandbar' as const,
      object: { kind: 'rubble' as const },
    };
    map.tacticalCells = [feature];
    const parsed = operationalMapSchema.parse(map);
    const ledger = buildSupplyLedger(parsed);
    expect(ledger.routes[0]!.segments[0]!.cells[1]).toMatchObject({ terrain: 'sandbar', object: { kind: 'rubble' } });
    expect(() => verifySupplyLedger(ledger, parsed, true)).not.toThrow();
    map.tacticalCells = [feature, feature];
    expect(operationalMapSchema.safeParse(map).success).toBe(false);
    map.tacticalCells = [{ ...feature, x: 256, y: 256 }];
    expect(operationalMapSchema.safeParse(map).success).toBe(false);
  });
  it('모래톱 이동은 평지와 여울 사이이며 불함정·구멍을 설치할 수 없다', () => {
    expect(movementCost('plain')).toBeLessThan(movementCost('sandbar'));
    expect(movementCost('sandbar')).toBeLessThan(movementCost('ford'));
    const { world, battle: b } = tacticalFixture();
    b.bases = [];
    const payload = {
      worldId: 'world',
      battleId: b.id,
      expectedRevision: b.revision,
      windowNo: b.windowNo,
      mapHash: b.mapHash,
      idempotencyKey: 'trap',
      ready: false,
    };
    for (const [terrain, kind, ok] of [
      ['sandbar', 'fire', false],
      ['sandbar', 'pit', false],
      ['grass', 'fire', true],
      ['bridge', 'fire', true],
      ['plain', 'fire', false],
      ['forest', 'fire', false],
      ['grass', 'pit', true],
      ['plain', 'pit', true],
      ['road', 'pit', true],
    ] as const) {
      b.board.terrain[8] = terrain;
      const result = applyBattleInput(world, 'battle.council', { ...payload, traps: [{ kind, x: 8, y: 0 }] }, 2);
      expect(result.ok, `${terrain}/${kind}`).toBe(ok);
    }
  });

  it('실제 부대 이동은 모래톱과 무너진 터의 이동 비용을 소비한다', () => {
    const { battle: b } = tacticalFixture();
    closeCouncil(b);
    b.units[0]!.move = 3;
    const orders = [
      { unitId: 1, action: { kind: 'move' as const, x: 3, y: 0 } },
      { unitId: 2, action: { kind: 'hold' as const } },
    ];
    expect(resolveBattleTurn(b, orders, testUnits).units[0]!.x).toBe(3);
    b.board.terrain[1] = 'sandbar';
    expect(resolveBattleTurn(b, orders, testUnits).units[0]!.x).toBe(2);
    b.board.terrain[1] = 'plain';
    b.board.objects.push({ kind: 'rubble', x: 1, y: 0 });
    expect(resolveBattleTurn(b, orders, testUnits).units[0]!.x).toBe(2);
  });

  it('흙더미는 교전 양쪽의 받는 피해를 각각 줄인다', () => {
    const { battle: b } = tacticalFixture();
    closeCouncil(b);
    b.units[0]!.x = 4;
    b.units[1]!.x = 5;
    const orders = [
      { unitId: 1, action: { kind: 'attack' as const, target: 2 } },
      { unitId: 2, action: { kind: 'hold' as const } },
    ];
    const baseline = resolveBattleTurn(b, orders, testUnits);
    b.board.objects.push({ kind: 'earthwork', x: 5, y: 0 });
    expect(resolveBattleTurn(b, orders, testUnits).units[1]!.troops).toBeGreaterThan(baseline.units[1]!.troops);
    b.board.objects = [{ kind: 'earthwork', x: 4, y: 0 }];
    expect(resolveBattleTurn(b, orders, testUnits).units[0]!.troops).toBeGreaterThan(baseline.units[0]!.troops);
  });

  it('원장에 명시한 모래톱·흙더미와 두 다리 방향을 판에 보존한다', () => {
    const { world } = tacticalFixture();
    delete world.campaign!.tactical;
    const cells = world.campaign!.supplyLedger!.routes[0]!.segments[0]!.cells;
    cells[1]!.terrain = 'sandbar';
    cells[1]!.object = { kind: 'earthwork' };
    cells[2]!.terrain = 'bridge';
    cells[2]!.object = { kind: 'bridge', direction: 'NE-SW' };
    cells[3]!.terrain = 'bridge';
    cells[3]!.object = { kind: 'bridge', direction: 'NW-SE' };
    const b = openTacticalBattle(
      world,
      101,
      world.campaign!.units.slice(0, 1),
      world.campaign!.units.slice(1),
      2,
      testUnits,
    );
    expect(b.board.terrain[1]).toBe('sandbar');
    expect(b.board.objects).toEqual(
      expect.arrayContaining([
        { kind: 'earthwork', x: 1, y: 0 },
        { kind: 'bridge', direction: 'NE-SW', x: 2, y: 0 },
        { kind: 'bridge', direction: 'NW-SE', x: 3, y: 0 },
      ]),
    );
    expect(b.bases.every((base) => base.structure === 'camp')).toBe(true);
    b.units[0]!.x = 1;
    expect(terrainDefense(b, b.units[0]!)).toBe(0.85);
  });

  it('물과 자료 없는 칸은 타지 않고 눈·비는 발화 확률을 낮춘다', () => {
    const { battle: b } = tacticalFixture();
    for (const terrain of ['sea', 'river', 'ford'] as const) {
      b.board.terrain[1] = terrain;
      expect(canIgnite(b, { x: 1, y: 0 })).toBe(false);
    }
    b.board.terrain[1] = 'grass';
    const counts = { clear: 0, rain: 0, snow: 0 };
    for (const weather of ['clear', 'rain', 'snow'] as const) {
      b.weather = weather;
      for (let i = 0; i < 100; i++) {
        b.burningCells = [];
        if (ignite(b, { x: 1, y: 0 }, `test:${i}`)) counts[weather]++;
      }
    }
    expect(counts.clear).toBeGreaterThan(counts.rain);
    expect(counts.rain).toBeGreaterThan(counts.snow);
    b.cells[1]!.sourceTileId = '';
    expect(canIgnite(b, { x: 1, y: 0 })).toBe(false);
    expect(canIgnite(b, { x: -1, y: 0 })).toBe(false);
  });

  it('불은 한 정산에 바람 쪽 한 칸만 번지고 병사와 장수가 피해를 받는다', () => {
    const { world, battle: b } = tacticalFixture();
    b.weather = 'clear';
    b.wind = 'E';
    b.burningCells = [{ x: 0, y: 0 }];
    let injured = false,
      spread = false;
    for (let i = 0; i < 100; i++) {
      const copy = structuredClone(b);
      copy.turn = i % 30;
      copy.seed = `fire:${i}`;
      const events: TacticalEvent[] = [];
      resolveFire(copy, events);
      expect(copy.units[0]!.troops).toBe(950);
      expect(copy.burningCells.every((c) => c.x <= 1)).toBe(true);
      injured ||= copy.units[0]!.injury > 0;
      spread ||= copy.burningCells.some((c) => c.x === 1);
      const same = structuredClone(b);
      same.turn = copy.turn;
      same.seed = copy.seed;
      resolveFire(same, []);
      expect(same).toEqual(copy);
    }
    expect(injured).toBe(true);
    expect(spread).toBe(true);
    b.phase = 'ended';
    b.result = 'defend';
    b.units[0]!.injury = 4;
    const before = world.generals[1]!.injury;
    settleTacticalBattle(world, b);
    settleTacticalBattle(world, b);
    expect(world.generals[1]!.injury).toBe(before + 4);
    b.weather = 'downpour';
    resolveFire(b, []);
    expect(b.burningCells).toEqual([]);
    expect(ignite(b, { x: 0, y: 0 }, 'rain')).toBe(false);
  });

  it('기상 변화가 결정적이고 화계·불함정이 실제 정산에서 칸에 불을 붙인다', () => {
    const { battle: original } = tacticalFixture();
    closeCouncil(original);
    original.weather = 'clear';
    original.bases = [];
    original.schemes = [{ kind: 'fire', x: 0, y: 0, side: 'attack', turn: 1, used: false }];
    const orders = original.units.map((u) => ({ unitId: u.id, action: { kind: 'hold' as const } }));
    let schemeLit = false,
      trapLit = false,
      changed = false,
      blocked = false;
    for (let i = 0; i < 80; i++) {
      const b = structuredClone(original);
      b.seed = `weather:${i}`;
      const weather = structuredClone(b);
      weather.turn = 1;
      updateWeather(weather);
      changed ||= weather.weather !== 'clear' || weather.wind !== b.wind;
      const next = resolveBattleTurn(b, orders, testUnits);
      expect(resolveBattleTurn(tacticalBattleSchema.parse(JSON.parse(JSON.stringify(b))), orders, testUnits)).toEqual(
        next,
      );
      schemeLit ||= next.burningCells.some((c) => c.x === 0);
      if (next.weather === 'downpour') {
        blocked = true;
        expect(next.burningCells).toEqual([]);
        expect(next.sides.attack.schemePoints).toBe(b.sides.attack.schemePoints);
      }
      b.schemes = [];
      b.traps = [{ kind: 'fire', x: 1, y: 0, spent: false, revealed: false }];
      b.board.terrain[1] = 'grass';
      const trapped = resolveBattleTurn(
        b,
        [{ unitId: 1, action: { kind: 'move', x: 1, y: 0 } }, orders[1]!],
        testUnits,
      );
      trapLit ||= trapped.burningCells.some((c) => c.x === 1);
      expect(battleStateHash(trapped)).not.toBe(battleStateHash(b));
    }
    expect(schemeLit && trapLit && changed && blocked).toBe(true);
  });

  it('날씨·숲·산 시야와 복병·사건·불 가림을 프레임에 적용한다', () => {
    const { battle: b } = tacticalFixture();
    b.bases = [];
    b.weather = 'clear';
    const own = b.units[0]!,
      foe = b.units[1]!;
    foe.x = 3;
    expect(visionRange(b, own)).toBe(3);
    expect(visibleTo(b, 'attack', foe)).toBe(true);
    b.weather = 'fog';
    expect(visionRange(b, own)).toBe(1);
    expect(visibleTo(b, 'attack', foe)).toBe(false);
    b.weather = 'downpour';
    expect(visionRange(b, own)).toBe(2);
    b.weather = 'clear';
    b.board.terrain[0] = 'mountain';
    expect(visionRange(b, own)).toBe(4);
    b.board.terrain[0] = 'forest';
    expect(visionRange(b, own)).toBe(2);
    b.board.terrain[0] = 'plain';
    b.board.terrain[1] = 'forest';
    expect(visibleTo(b, 'attack', foe)).toBe(false);
    b.board.terrain[1] = 'plain';
    foe.x = 2;
    foe.status = 'ambush';
    b.burningCells = [{ x: 10, y: 0 }];
    recordBattleFrame(b, [{ kind: 'move', actorId: foe.id, text: '숨은 이동' }]);
    const frame = tacticalView(b, 'attack').frames[0]!;
    expect(frame.units.map((u) => u.id)).toEqual([own.id]);
    expect(frame.events).toEqual([]);
    expect(frame.burningCells).toEqual([]);
    expect(frame.visibleCells).toContainEqual({ x: 3, y: 0 });
    expect(frame.visibleCells).not.toContainEqual({ x: 10, y: 0 });
    expect(tacticalFrameSchema.parse(frame)).toEqual(frame);
    expect(
      battleCouncilInputSchema.safeParse({
        worldId: 'w',
        battleId: b.id,
        expectedRevision: 0,
        windowNo: 0,
        mapHash: b.mapHash,
        idempotencyKey: 'key',
        ready: false,
        schemes: [{ kind: 'fire', turn: 1, x: 1, y: 0 }],
      }).success,
    ).toBe(true);
  });
});
