import { describe, it, expect } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { tacticalFixture, testUnits } from '../../test/tacticalFixture';
import { resolveBattleTurn, closeCouncil, battleStateHash, recordBattleFrame } from './battle';
import { battleBusy, battleCommandBusy, settleTacticalBattle, openTacticalBattle } from './world';
import { applyBattleStep, applyBattleInput } from './input';
import { tacticalView, battleDuration, tacticalBattleSchema } from './state';
import { tacticalClock } from './clock';
import { runMonthly } from '../monthly';
import { applyCityResourceInput } from '../cityResources/input';
import { applyCampaignUnitInput } from '../campaign/unitInputs';
import { runOfficeAssign } from '../personnel/officeTurn';
import { tacticalMap } from './map';
import { tacticalInputKinds } from './input';
import { applyRecordedInput, type ReplayState } from '../replay';
import { battleHash } from './state';

describe('AC-INT-28 전술 전투·번들 잠금', () => {
  it('해시는 JSON 키 순서에 영향받지 않고 유니코드 문자 전체를 구분한다', () => {
    expect(battleHash({ a: 1, b: 2 })).toBe(battleHash({ b: 2, a: 1 }));
    expect(battleHash('😀')).not.toBe(battleHash('😁'));
  });
  it('경유 간선과 선택한 복수 경로를 보급과 같은 원장에서 읽는다', () => {
    const { world } = tacticalFixture();
    delete world.campaign!.tactical;
    const route = world.campaign!.supplyLedger!.routes[0]!;
    world.campaign!.supplyLedger!.routes = [
      { ...structuredClone(route), to: 3, routeId: 'first' },
      { ...structuredClone(route), from: 3, routeId: 'second' },
    ];
    const b = openTacticalBattle(
      world,
      101,
      world.campaign!.units.slice(0, 1),
      world.campaign!.units.slice(1),
      2,
      testUnits,
      { routeId: 'first/second' },
    );
    expect(b.cells.some((c) => c.sourceTileId === 'cell:11:0')).toBe(true);
    delete world.campaign!.tactical;
    world.campaign!.supplyLedger!.routes = [
      route,
      {
        ...structuredClone(route),
        routeId: 'other',
        segments: route.segments.map((s) => ({ ...s, cells: s.cells.map((c) => ({ ...c, y: 32 })) })),
      },
    ];
    const chosen = openTacticalBattle(world, 102, world.campaign!.units.slice(0, 1), [], 2, testUnits, {
      routeId: 'other',
    });
    expect(chosen.cells[0]!.sourceTileId).toBe('cell:0:0');
    expect(chosen.board.height).toBe(1);
  });
  it('실제 2차원 경로와 명시 대각선 간선을 보존하며 자료 없는 칸은 통행하지 않는다', () => {
    const { world } = tacticalFixture();
    delete world.campaign!.tactical;
    for (const cell of world.campaign!.supplyLedger!.routes[0]!.segments[0]!.cells) cell.y = cell.x;
    const b = openTacticalBattle(
      world,
      101,
      world.campaign!.units.slice(0, 1),
      world.campaign!.units.slice(1),
      2,
      testUnits,
    );
    expect(b.board.height).toBe(12);
    expect(b.edges).toContainEqual([0, 13]);
    closeCouncil(b);
    const next = resolveBattleTurn(
      b,
      [
        { unitId: 1, action: { kind: 'move', x: 1, y: 1 } },
        { unitId: 2, action: { kind: 'hold' } },
      ],
      testUnits,
    );
    expect(next.units[0]).toMatchObject({ x: 1, y: 1 });
    expect(b.cells[1]!.sourceTileId).toBe('');
    const map = tacticalMap(world, world.campaign!.supplyLedger!.routes[0]!, 2, 1);
    expect(map.cells).toHaveLength(144);
  });
  it('취소는 같은 턴 프레임을 갱신해 최종 사건을 다시보기에 남긴다', () => {
    const { world, battle } = tacticalFixture();
    const next = applyBattleStep(
      world,
      { battleId: battle.id, now: 100, turnTermMinutes: 60, present: false, orders: [], cancel: '관리자 종료' },
      testUnits,
    );
    const b = next.campaign!.tactical!.battles[0]!;
    expect(b.frames).toHaveLength(1);
    expect(tacticalView(b, 'attack').frames[0]!.events.at(-1)!.kind).toBe('end');
  });
  it('마지막 도시 점령은 남은 관문 수비병을 민간으로 돌리고 국가를 없앤다', () => {
    const { world, battle } = tacticalFixture();
    world.cities[3]!.nationId = 2;
    world.cities[3]!.kind = 'PASS';
    world.cityResources!.cities['3']!.garrison = [{ crewType: 1100, troops: 100, train: 100, atmos: 100 }];
    const population = world.cities[3]!.population;
    battle.phase = 'ended';
    battle.result = 'attack';
    battle.units[1]!.troops = 0;
    settleTacticalBattle(world, battle);
    expect(world.nations[2]).toBeUndefined();
    expect(world.cityResources!.cities['3']!.garrison).toEqual([]);
    expect(world.cities[3]!.population).toBe(population + 100);
  });
  it('기본 AI는 수비병 없는 성문에 접근해 벽·문을 함께 손상시킨다', () => {
    const { battle } = tacticalFixture(8);
    battle.units = battle.units.filter((u) => u.side === 'attack');
    battle.defense = 'hold';
    closeCouncil(battle);
    let next = battle;
    for (let i = 0; i < 8 && next.phase !== 'ended'; i++) next = resolveBattleTurn(next, [], testUnits);
    expect(next.siege!.gate).toBeLessThan(battle.siege!.gate);
  });
  it('전술 시스템 기록도 인사 외 상태 후처리와 같은 재생 경계를 쓴다', () => {
    const { world, battle } = tacticalFixture();
    const payload = { battleId: battle.id, now: 100, turnTermMinutes: 60, present: false, orders: [], cancel: null };
    const computed = applyBattleStep(world, payload, testUnits),
      b = computed.campaign!.tactical!.battles[0]!;
    const replay: ReplayState = { state: world, turns: {}, revisions: {}, monthlyTick: 0, campaignUnitSet: testUnits };
    const next = applyRecordedInput(
      replay,
      {
        sequence: 1,
        tick: 100,
        generalId: null,
        kind: 'battle.step',
        status: 'APPLIED',
        payload,
        result: { hash: battleStateHash(b) },
      },
      {
        inputKinds: tacticalInputKinds,
        features: [
          { key: 'campaign-v1', requires: [], conflicts: [] },
          {
            key: 'post',
            requires: [],
            conflicts: [],
            afterAppliedInput(_before, after, _input, context) {
              expect(context?.route).toBe('queued');
              return after;
            },
          },
        ],
      },
    );
    expect(battleHash(next.state)).toBe(battleHash(computed));
  });
  it('동일 시드·명령의 RESERVED와 LIVE 피해·사기·SP 및 턴 기록이 같다', () => {
    const { battle } = tacticalFixture();
    closeCouncil(battle);
    const live = structuredClone(battle);
    live.mode = 'LIVE';
    const orders = battle.units.map((u) => ({ unitId: u.id, action: { kind: 'hold' as const } }));
    const reserved = resolveBattleTurn(battle, orders, testUnits),
      direct = resolveBattleTurn(live, orders, testUnits);
    expect(battleStateHash(reserved)).toBe(battleStateHash(direct));
    expect(reserved.records).toEqual(direct.records);
    expect(resolveBattleTurn(battle, orders, testUnits)).toEqual(reserved);
  });
  it('교전 RNG와 JSON 재적재 뒤 같은 명령 재생 결과가 같다', () => {
    const { battle } = tacticalFixture();
    closeCouncil(battle);
    battle.units[0]!.x = 4;
    battle.units[1]!.x = 5;
    const orders = [
      { unitId: 1, action: { kind: 'attack' as const, target: 2 } },
      { unitId: 2, action: { kind: 'hold' as const } },
    ];
    const next = resolveBattleTurn(battle, orders, testUnits);
    expect(next.records[0]!.events.some((e) => e.exchange)).toBe(true);
    expect(
      resolveBattleTurn(tacticalBattleSchema.parse(JSON.parse(JSON.stringify(battle))), orders, testUnits),
    ).toEqual(next);
    expect(next.units[0]!.troops).toBeLessThan(1000);
  });
  it('잠긴 부곡·장수·대상 거점은 충돌하고 다른 장수는 진행한다', () => {
    const { world, battle } = tacticalFixture();
    expect(battleBusy(world, { unitIds: [1] })).toBe(true);
    expect(battleBusy(world, { generalIds: [4] })).toBe(false);
    expect(battleCommandBusy(world, 1, 'move', { cityKey: 4 })).toBe(true);
    expect(battleCommandBusy(world, 4, 'rest', {})).toBe(false);
    expect(() => openTacticalBattle(world, 101, world.campaign!.units.slice(0, 1), [], 2, testUnits)).toThrow(
      'BATTLE_BUSY',
    );
    expect(
      applyCityResourceInput(world, { cityKey: 2, unitId: 2, crewType: 1100, amount: 1 }, 2, {
        tick: 100,
        userId: 'defender',
        userActive: true,
        armyTypes: [1100],
      }),
    ).toMatchObject({ ok: false, code: 'BATTLE_BUSY' });
    expect(
      applyCampaignUnitInput(
        world,
        { type: 'command', unitId: 1, commanderId: 1, revision: world.campaign!.revision },
        1,
        world.campaign,
        { tick: 100, userId: 'attacker', userActive: true, armyTypes: [1100], unitSet: testUnits },
      ),
    ).toMatchObject({ ok: false, code: 'BATTLE_BUSY' });
    expect(runOfficeAssign(world, { generalId: 1 }, { generalId: 2, cityKey: 1 }, 100).result).toMatchObject({
      code: 'BATTLE_BUSY',
    });
    battle.phase = 'ended';
    battle.result = 'defend';
    settleTacticalBattle(world, battle);
    expect(battleBusy(world, { unitIds: [1] })).toBe(false);
  });
  it('30턴을 넘기지 않으며 마지막 야전 승리가 성을 즉시 점령하지 않는다', () => {
    const { battle } = tacticalFixture();
    closeCouncil(battle);
    battle.turn = 29;
    battle.units[1]!.status = 'routed';
    const next = resolveBattleTurn(battle, [{ unitId: 1, action: { kind: 'hold' } }], testUnits);
    expect(next).toMatchObject({ turn: 30, phase: 'ended', result: 'defend' });
    expect(() => resolveBattleTurn(next, [], testUnits)).toThrow('WINDOW_CLOSED');
  });
  it('농성은 1턴부터 공성, 야전 패주도 전체 턴을 유지해 공성으로 전환한다', () => {
    const { battle } = tacticalFixture();
    battle.defense = 'hold';
    closeCouncil(battle);
    expect(battle.phase).toBe('siege');
    expect(battle.sides.defend.morale).toBe(70);
    const { battle: field } = tacticalFixture();
    closeCouncil(field);
    field.units[1]!.status = 'routed';
    const next = resolveBattleTurn(field, [{ unitId: 1, action: { kind: 'hold' } }], testUnits);
    expect(next).toMatchObject({ phase: 'siege', turn: 1 });
    expect(next.sides.defend.morale).toBe(70);
  });
  it('전략 월 경계는 계속 지나며 잠긴 병력·성벽을 월간 보급 감소로 다시 깎지 않는다', () => {
    const { world } = tacticalFixture();
    world.cities[2]!.supplied = false;
    const next = runMonthly(world, 10000, rngFor('month'), rngFor('disaster')).state;
    expect(next.campaign!.units).toEqual(world.campaign!.units);
    expect(next.cities[2]!.wall).toBe(world.cities[2]!.wall);
    expect(next.campaign!.tactical!.battles[0]!.phase).toBe('council');
  });
  it('정산은 현재 월드 위에 피해 차분만 한 번 적용하고 월간 수입을 보존한다', () => {
    const { world, battle } = tacticalFixture();
    world.generals[1]!.rice += 123;
    const rice = world.generals[1]!.rice;
    battle.units[0]!.troops -= 100;
    battle.phase = 'ended';
    battle.result = 'defend';
    settleTacticalBattle(world, battle);
    expect(world.campaign!.units[0]!.troops).toBe(900);
    expect(world.generals[1]!.rice).toBe(rice + 300);
    const saved = JSON.stringify(world);
    settleTacticalBattle(world, battle);
    expect(JSON.stringify(world)).toBe(saved);
  });
  it('당시 시야 사본에서 적 병력·군량·숨은 위치와 교전 사건을 숨긴다', () => {
    const { battle } = tacticalFixture(20);
    expect(tacticalView(battle, 'attack').frames[0]!.units.map((u) => u.id)).toEqual([1]);
    expect(tacticalView(battle, 'attack').frames[0]!.totals.defend).toEqual({
      units: 0,
      troops: 0,
      rice: 0,
      morale: 0,
    });
    battle.units[1]!.x = 2;
    recordBattleFrame(battle, []);
    expect(battle.views.attack.at(-1)!.units).toHaveLength(2);
  });
  it('휴전·국가 멸망·참가 장수 제거는 손실 유지 정산으로 종료한다', () => {
    const { world, battle } = tacticalFixture();
    world.diplomacies = [];
    battle.units[0]!.troops = 900;
    const next = applyBattleStep(
      world,
      { battleId: battle.id, now: 1000, turnTermMinutes: 60, present: false, orders: [], cancel: null },
      testUnits,
    );
    expect(next.campaign!.tactical!.battles[0]).toMatchObject({ settled: true, result: 'defend' });
    expect(next.campaign!.units[0]!.troops).toBe(900);
  });
  it('LIVE 총 시간 상한과 관리자 정지·재개의 남은 시간을 보존한다', () => {
    const { world, battle } = tacticalFixture();
    const payload = { battleId: battle.id, now: 1000, turnTermMinutes: 60, present: true, orders: [], cancel: null };
    let next = applyBattleStep(world, payload, testUnits);
    let b = next.campaign!.tactical!.battles[0]!;
    expect(b.turnMs * 30 + b.councilMs).toBeLessThanOrEqual(3600000);
    next = tacticalClock(next, 'pause', 2000);
    next = tacticalClock(next, 'resume', 12000);
    b = next.campaign!.tactical!.battles[0]!;
    expect(b.deadlineAt).toBe(131000);
    next = applyBattleStep(next, { ...payload, now: 131000 }, testUnits);
    b = next.campaign!.tactical!.battles[0]!;
    expect(b.mode).toBe('LIVE');
    next = applyBattleStep(next, { ...payload, now: b.hardDeadlineAt }, testUnits);
    expect(next.campaign!.tactical!.battles[0]!.settled).toBe(true);
    expect(battleDuration(1).turnMs).toBe(0);
  });
  it('예약은 지도·경로·자기 부곡·revision을 검사한다', () => {
    const { world, battle } = tacticalFixture();
    const payload = {
      worldId: 'world',
      battleId: battle.id,
      expectedRevision: battle.revision,
      windowNo: 0,
      mapHash: battle.mapHash,
      idempotencyKey: 'key',
      units: [{ unitId: 1, path: [{ x: 1, y: 0 }], rules: [], fallback: { kind: 'followPath' } }],
    };
    expect(applyBattleInput(world, 'battle.plan', payload, 1).ok).toBe(true);
    expect(applyBattleInput(world, 'battle.plan', { ...payload, mapHash: 'bad' }, 1)).toMatchObject({
      code: 'MAP_MISMATCH',
    });
    expect(
      applyBattleInput(world, 'battle.plan', { ...payload, units: [{ ...payload.units[0], unitId: 2 }] }, 1),
    ).toMatchObject({ code: 'NOT_ALLOWED' });
  });
});
