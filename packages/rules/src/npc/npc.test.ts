import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { commandRegistry } from '../commands/registry';
import { runGeneralTurn } from '../commands/turn';
import { BALANCE } from '../balance';
import { chooseGeneralTurn, chooseNationTurn } from './index';

const context = { tick: 100, unitSet: testUnits };
function rearWorld() {
  const world = commandWorld();
  world.cities[1]!.connections = [4];
  world.cities[4]!.connections = [1, 2];
  world.cities[4]!.supplied = true;
  return world;
}
describe('AC-M1-17 NPC 판단', () => {
  it('잘못된 휴식 인자는 빈 슬롯으로 바꾸지 않고 실패시킨다', () => {
    const world = commandWorld();
    world.nationTurns = { 1: [{ commandKey: 'nation_rest', args: { invalid: true } }] };
    const turn = runGeneralTurn(
      world,
      { ...context, generalId: 1 },
      { commandKey: 'rest', args: { invalid: true } },
      'npc',
    );
    expect(turn.result).toMatchObject({ code: 'BAD_ARGS' });
    expect(turn.nation?.result).toMatchObject({ code: 'BAD_ARGS' });
    expect(turn.commandKey).toBe('rest');
  });
  it('재야 장수는 임관 후보와 점수·이유를 돌려준다', () => {
    const world = commandWorld();
    const decision = chooseGeneralTurn(world, world.generals[4]!, rngFor('npc'), context);
    expect(decision.chosen?.key).toBe('join');
    expect(decision.candidates.every((c) => Number.isFinite(c.score) && c.reason.length > 0)).toBe(true);
  });
  it('적 접경에서 병력이 없으면 모병하고 준비가 끝나면 출병한다', () => {
    const world = commandWorld();
    world.generals[1]!.crew = 0;
    expect(chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context).chosen?.key).toBe('recruit');
    world.generals[1]!.crew = 10000;
    expect(chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context).chosen).toMatchObject({
      key: 'attack',
      args: { cityKey: 2 },
    });
  });
  it('준비를 마쳤지만 출병 대상이 없는 전선 장수는 이웃 전선으로 이동하지 않는다', () => {
    const world = commandWorld();
    world.diplomacies = [];
    world.cities[1]!.connections.push(4);
    world.cities[4]!.connections = [1, 2];
    world.cities[4]!.supplied = true;
    expect(commandRegistry.get('move')!.check(world, { ...context, generalId: 1 }, { cityKey: 4 })).toBeNull();
    const decision = chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context);
    expect(decision.candidates.some((c) => c.key === 'attack' || c.key === 'move')).toBe(false);
    expect(decision.chosen?.key).not.toBe('move');
  });
  it('후방 장수는 전선으로 이동할 수 있어도 부족한 내정을 먼저 채운다', () => {
    const world = rearWorld();
    const decision = chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context);
    const move = decision.candidates.find((c) => c.key === 'move');
    expect(move).toMatchObject({ args: { cityKey: 4 }, score: 60 });
    expect(commandRegistry.get(decision.chosen!.key)!.category).toBe('domestic');
    expect(decision.chosen!.score).toBeGreaterThan(move!.score);
    expect(decision.chosen!.reason).toBe('후방에서는 전선 이동보다 부족한 내정을 먼저 채운다.');
  });
  it('내정을 모두 채운 후방 장수는 자기 영토를 따라 전선으로 이동한다', () => {
    const world = rearWorld();
    const city = world.cities[1]!;
    city.agriculture = city.agricultureMax;
    city.commerce = city.commerceMax;
    city.security = city.securityMax;
    city.population = city.populationMax;
    city.defence = city.defenceMax;
    city.wall = city.wallMax;
    city.trust = BALANCE.MAX_TRUST;
    world.nations[1]!.tech = BALANCE.MAX_TECH;
    expect(chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context).chosen).toMatchObject({
      key: 'move',
      args: { cityKey: 4 },
      reason: '후방에서 자기 영토를 따라 가까운 전선으로 한 칸 이동한다.',
    });
  });
  it('후보는 모두 같은 Actor로 check를 통과하고 판단은 입력을 바꾸지 않는다', () => {
    const world = commandWorld();
    const before = structuredClone(world);
    const general = world.generals[1]!;
    const decision = chooseGeneralTurn(world, general, rngFor('npc'), context);
    for (const c of decision.candidates)
      expect(commandRegistry.get(c.key)!.check(world, { ...context, generalId: general.id }, c.args)).toBeNull();
    expect(world).toEqual(before);
    expect(chooseGeneralTurn(world, general, rngFor('npc'), context)).toEqual(decision);
  });
  it('사람 장수는 판단하거나 대신 실행하지 않고 NPC의 지정 명령도 보존한다', () => {
    const world = commandWorld();
    world.generals[1]!.userId = 'human';
    expect(chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), context)).toEqual({
      chosen: null,
      candidates: [],
    });
    expect(chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).chosen).toBeNull();
    expect(
      runGeneralTurn(world, { ...context, generalId: 1 }, { commandKey: 'rest', args: {} }, 'npc').commandKey,
    ).toBe('rest');
    world.generals[1]!.userId = null;
    expect(
      runGeneralTurn(world, { ...context, generalId: 1 }, { commandKey: 'heal', args: {} }, 'npc').commandKey,
    ).toBe('heal');
  });
  it('군주는 접경국에 선포하고 포상하며 사람 국가는 대행하지 않는다', () => {
    const world = commandWorld();
    world.diplomacies = [];
    expect(chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).chosen?.key).toBe('nation_declare');
    world.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
    world.generals[1]!.gold = 0;
    expect(chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).chosen?.key).toBe('nation_reward');
    world.nations[1]!.isNpc = false;
    expect(chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).chosen).toBeNull();
  });
  it('더 연결된 도시가 있을 때만 고립된 수도를 옮긴다', () => {
    const world = commandWorld();
    expect(
      chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).candidates.some(
        (c) => c.key === 'nation_capital',
      ),
    ).toBe(false);
    world.cities[3]!.nationId = 1;
    expect(chooseNationTurn(world, world.generals[1]!, rngFor('npc'), context).chosen?.key).toBe('nation_capital');
  });
  it('국가 포상 뒤 장수 명령을 다시 판단하고 수렴 보조는 출병 점수만 바꾼다', () => {
    const world = commandWorld();
    world.generals[1]!.gold = 0;
    world.generals[1]!.crew = 0;
    const turn = runGeneralTurn(world, { ...context, generalId: 1 }, { commandKey: 'rest', args: {} }, 'npc');
    expect(turn.nation?.commandKey).toBe('nation_reward');
    expect(turn.commandKey).toBe('recruit');
    world.generals[1]!.crew = 10000;
    const late = { ...context, tick: 50 * 12 * 10000 };
    const off = chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), { ...late, convergence: false });
    const on = chooseGeneralTurn(world, world.generals[1]!, rngFor('npc'), late);
    expect(on.candidates.find((c) => c.key === 'attack')?.score).toBe(
      (off.candidates.find((c) => c.key === 'attack')?.score ?? 0) + 2,
    );
  });
});
