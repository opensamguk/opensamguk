import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../test/commandFixture';
import { parsePreset, presetCommands, presetRules, resolverForPreset } from './preset';
import { toWorldState } from '../model/world';
import { cloneWorld } from '../model/clone';
import { commandRegistry, runCommand } from '../commands/registry';
import { lateJoinBonus, buildCreatedGeneral } from '../general/create';
import { chooseGeneralTurn, chooseNationTurn } from '../npc';
import { TICKS_PER_MONTH } from '../clock/constants';

const regular = {
  name: '정규',
  turnTermMinutes: 60,
  scenario: '1030',
  map: 'che',
  unitSet: 'basic',
  commands: null,
  npc: { fillRatio: 1, aggression: 1 },
  protection: { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
  boost: { smallWorld: null, lateJoin: null },
  features: { advisor: false },
};
const lateJoin = { fromYear: 3, experienceRatio: 0.8, percentile: 0.2, goldPerYear: 0, ricePerYear: 0, maxYears: 0 };
const speed = { ...regular, name: '속성', turnTermMinutes: 10, boost: { smallWorld: null, lateJoin } };
const beginner = {
  ...regular,
  name: '초보',
  turnTermMinutes: 30,
  npc: { fillRatio: 1, aggression: 0.5 },
  protection: { foundUntilMonths: 12, peaceMonths: 24, maxGeneralsPerNation: null },
  boost: {
    smallWorld: [{ below: 300, multiplier: 1.2 }],
    lateJoin: { ...lateJoin, goldPerYear: 100, ricePerYear: 100, maxYears: 5 },
  },
  features: { advisor: true },
};
const hardcore = { ...regular, name: '하드코어', npc: { fillRatio: 1, aggression: 1.5 } };
const presets = [regular, speed, beginner, hardcore];
const rules = () => presetRules(parsePreset(beginner));

describe('T2-02 프리셋 계약', () => {
  it('승인한 네 프리셋의 수치와 P3·P6 경계를 보존한다', () => {
    expect(presets.map((p) => parsePreset(p).turnTermMinutes)).toEqual([60, 10, 30, 60]);
    expect(presets.map((p) => parsePreset(p).npc.aggression)).toEqual([1, 1, 0.5, 1.5]);
    expect(presets.map((p) => parsePreset(p).protection.peaceMonths)).toEqual([0, 0, 24, 0]);
    expect(presets.map((p) => parsePreset(p).features.advisor)).toEqual([false, false, true, false]);
    for (const p of presets) {
      expect(parsePreset(p).npc.fillRatio).toBe(1);
      expect(parsePreset(p).protection.maxGeneralsPerNation).toBeNull();
    }
  });
  it.each([undefined, null, { general: [], nation: [] }])(
    '명령 목록 %j를 null로 정규화하고 기본 37개를 유지한다',
    (commands) => {
      const input: Record<string, unknown> = { ...regular, commands };
      if (commands === undefined) delete input.commands;
      const preset = parsePreset(input);
      expect(preset.commands).toBeNull();
      expect(presetCommands(preset)).toBeNull();
      const resolver = resolverForPreset(preset);
      expect([...resolver.list('general'), ...resolver.list('nation')]).toEqual([...commandRegistry.values()]);
      expect(resolverForPreset(null).get('farm')).toBe(commandRegistry.get('farm'));
    },
  );
  it.each([
    { extra: true },
    { turnTermMinutes: 0 },
    { turnTermMinutes: 2_147_483_648 },
    { turnTermMinutes: 1.5 },
    { scenario: '../1030' },
    { map: '' },
    { unitSet: '/basic' },
    { commands: { general: ['farm'], nation: [] } },
    { commands: { general: ['unknown'], nation: [] } },
    { commands: { general: ['nation_rest'], nation: [] } },
    { commands: { general: [], nation: [], ignored: true } },
    { npc: { fillRatio: 0.5, aggression: 1 } },
    { npc: { fillRatio: 1, aggression: 0 } },
    { npc: { fillRatio: 1, aggression: 3.1 } },
    { protection: { ...regular.protection, maxGeneralsPerNation: 5 } },
    { protection: { ...regular.protection, peaceMonths: -1 } },
    { boost: { ...regular.boost, smallWorld: [] } },
    { boost: { ...regular.boost, smallWorld: [{ below: 300, multiplier: 1 }] } },
    {
      boost: {
        ...regular.boost,
        smallWorld: [
          { below: 300, multiplier: 1.2 },
          { below: 200, multiplier: 1.3 },
        ],
      },
    },
    { boost: { ...regular.boost, lateJoin: { ...beginner.boost.lateJoin, percentile: 0 } } },
    { boost: { ...regular.boost, lateJoin: { ...beginner.boost.lateJoin, goldPerYear: 2_147_483_647 } } },
    { features: { advisor: true, extra: 1 } },
  ])('잘못되거나 아직 승인하지 않은 설정을 거부한다: %j', (patch) => {
    expect(() => parsePreset({ ...regular, ...patch })).toThrow();
  });
  it('초기 상태 변환·명령 복제에서 깊이 복사하고 레거시에는 키를 만들지 않는다', () => {
    const initial = commandInitial();
    expect(Object.hasOwn(toWorldState(initial), 'presetRules')).toBe(false);
    expect(Object.hasOwn(cloneWorld(toWorldState(initial)), 'presetRules')).toBe(false);
    initial.presetRules = rules();
    const view = toWorldState(initial);
    const copy = cloneWorld(view);
    copy.presetRules!.boost.smallWorld![0]!.multiplier = 2;
    expect(view.presetRules!.boost.smallWorld![0]!.multiplier).toBe(1.2);
    view.presetRules!.protection.peaceMonths = 1;
    expect(initial.presetRules.protection.peaceMonths).toBe(24);
    expect(Object.keys(presetRules(parsePreset(beginner))).sort()).toEqual(['boost', 'npc', 'protection']);
  });
});

describe('T2-02 초반 보호', () => {
  it.each([
    ['attack', 1, { cityKey: 2 }, 24, 'general'],
    ['nation_declare', 1, { nationId: 2 }, 24, 'nation'],
    ['found', 4, { name: '새나라', color: '#123456' }, 12, 'general'],
    ['uprising', 4, { name: '새나라', color: '#123456' }, 12, 'general'],
  ] as const)('%s는 마지막 보호 tick까지 사전 검사·실행에서 막힌다', (key, generalId, args, months, target) => {
    const world = commandWorld();
    if (key === 'nation_declare') world.diplomacies = [];
    world.presetRules = rules();
    const before = JSON.stringify(world);
    const actor = { generalId, target, tick: months * TICKS_PER_MONTH - 1, unitSet: testUnits };
    const command = commandRegistry.get(key)!;
    expect(command.precheck(world, actor, args)?.code).toBe('PROTECTED');
    expect(runCommand(world, actor, key, args, rngFor('protect'))).toMatchObject({ code: 'PROTECTED' });
    expect(command.precheck(world, { ...actor, tick: months * TICKS_PER_MONTH }, args)).toBeNull();
    expect(
      runCommand(world, { ...actor, tick: months * TICKS_PER_MONTH }, key, args, rngFor('protect')),
    ).toHaveProperty('effects');
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe('T2-02 NPC 출병 후보 가중치', () => {
  it('후보의 출병·선포 점수만 곱하고 최고점 선택과 RNG 소비를 보존한다', () => {
    for (const aggression of [1, 0.5, 1.5]) {
      const world = commandWorld();
      const legacyRng = rngFor('legacy-npc');
      const legacy = chooseGeneralTurn(world, world.generals[1]!, legacyRng, { unitSet: testUnits });
      world.presetRules = presetRules(parsePreset({ ...regular, npc: { fillRatio: 1, aggression } }));
      const presetRng = rngFor('legacy-npc');
      const choice = chooseGeneralTurn(world, world.generals[1]!, presetRng, { unitSet: testUnits });
      for (const candidate of legacy.candidates) {
        expect(
          choice.candidates.find(
            (c) => c.key === candidate.key && JSON.stringify(c.args) === JSON.stringify(candidate.args),
          )?.score,
        ).toBe(candidate.score * (candidate.key === 'attack' ? aggression : 1));
      }
      expect(presetRng.next()).toBe(legacyRng.next());
      if (aggression === 1) expect(choice).toEqual(legacy);
      world.diplomacies = [];
      world.generals[1]!.gold = 0;
      const nation = chooseNationTurn(world, world.generals[1]!, rngFor('weighted'), {});
      expect(nation.candidates.find((c) => c.key === 'nation_declare')?.score).toBe(100 * aggression);
    }
  });
  it('1.5배 출병이 훈련보다 앞서고 0.5배 선포는 포상과 동률이 된다', () => {
    const world = commandWorld();
    world.generals[1]!.train = 59;
    const regularChoice = chooseGeneralTurn(world, world.generals[1]!, rngFor('weights'), { unitSet: testUnits });
    world.presetRules = presetRules(parsePreset(hardcore));
    const hardcoreChoice = chooseGeneralTurn(world, world.generals[1]!, rngFor('weights'), { unitSet: testUnits });
    expect(regularChoice.chosen?.key).toBe('train');
    expect(hardcoreChoice.chosen?.key).toBe('attack');
    world.presetRules.npc.aggression = 0.5;
    world.generals[1]!.gold = 0;
    world.diplomacies = [];
    const decision = chooseNationTurn(world, world.generals[1]!, rngFor('weights'), {});
    expect(
      decision.candidates
        .filter((c) => c.score === 50)
        .map((c) => c.key)
        .sort(),
    ).toEqual(['nation_declare', 'nation_reward']);
  });
});

describe('T2-02 인원 보정', () => {
  it.each(['farm', 'research', 'goodwill'])('%s 도시·국가 변화만 늘리고 경험·공헌·난수 소비는 같다', (key) => {
    const world = commandWorld();
    const command = commandRegistry.get(key)!;
    const actor = { generalId: 1 };
    world.diplomacies = [];
    const rng = { ...rngFor('boost'), next: () => 0.5 };
    const base = command.execute(world, actor, {}, rng);
    world.presetRules = rules();
    const boostedRng = { ...rngFor('boost'), next: () => 0.5 };
    const boosted = command.execute(world, actor, {}, boostedRng);
    const change = base.effects[0]!;
    const larger = boosted.effects[0]!;
    if (!('value' in change) || !('value' in larger)) throw new Error('도시·국가 변화가 없습니다.');
    expect(larger.value).toBe(key === 'goodwill' ? change.value * 1.2 : Math.round(Number(change.value) * 1.2));
    expect(boosted.effects.slice(1)).toEqual(base.effects.slice(1));
    expect(boostedRng.next()).toBe(rng.next());
  });
  it('사람 장수가 기준과 같으면 보정하지 않고 NPC는 사람 수에 넣지 않는다', () => {
    const world = commandWorld();
    const command = commandRegistry.get('farm')!;
    const base = command.execute(world, { generalId: 1 }, {}, rngFor('threshold'));
    world.presetRules = rules();
    world.presetRules.boost.smallWorld = [
      { below: 1, multiplier: 1.2 },
      { below: 2, multiplier: 1.5 },
    ];
    world.generals[1]!.userId = 'human1';
    const larger = command.execute(world, { generalId: 1 }, {}, rngFor('threshold'));
    expect(larger.effects).not.toEqual(base.effects);
    world.generals[2]!.userId = 'human2';
    expect(command.execute(world, { generalId: 1 }, {}, rngFor('threshold')).effects).toEqual(base.effects);
  });
});

describe('T2-02 늦은 참가 보정', () => {
  const pool = Array.from({ length: 13 }, (_, i) => ({ id: 13 - i, nationId: 1, experience: i * 100 + 1 }));
  it.each([
    [0, 1000],
    [1, 1100],
    [2, 1200],
    [3, 1300],
    [5, 1500],
    [8, 1500],
  ])('%i년의 금·쌀 %i와 경험 시작 연도를 따로 계산한다', (year, resources) => {
    const config = parsePreset(beginner).boost.lateJoin;
    expect(lateJoinBonus(config, year, pool)).toEqual({
      gold: resources,
      rice: resources,
      experience: year >= 3 ? 161 : 0,
    });
  });
  it('국가 소속만 세고 빈 풀은 0이며 반올림한 1-based 지점을 쓴다', () => {
    const config = parsePreset(speed).boost.lateJoin;
    expect(lateJoinBonus(config, 3, [])).toEqual({ gold: 1000, rice: 1000, experience: 0 });
    expect(lateJoinBonus(config, 3, [{ id: 1, nationId: null, experience: 10000 }]).experience).toBe(0);
    expect(lateJoinBonus(config, 3, pool.slice(0, 7)).experience).toBe(1);
    expect(lateJoinBonus(config, 3, [...pool, { id: 99, nationId: null, experience: 0 }]).experience).toBe(161);
    expect(lateJoinBonus(null, 10, pool)).toEqual({ gold: 1000, rice: 1000, experience: 0 });
  });
  it('생성 보정은 도시·상성·턴 offset RNG를 바꾸지 않는다', () => {
    const input = {
      payload: { name: '새장수', leadership: 55, strength: 55, intel: 55, portraitId: null },
      seed: 'late',
      userId: 'user',
      id: 99,
      startYear: 191,
      monthlyTick: 360000,
      tick: 360001,
      cityKeys: [1, 2, 3],
      unitSet: testUnits,
    };
    const plain = buildCreatedGeneral(input);
    const boosted = buildCreatedGeneral({
      ...input,
      bonus: lateJoinBonus(parsePreset(beginner).boost.lateJoin, 3, pool),
    });
    expect(boosted).toEqual({ ...plain, gold: 1300, rice: 1300, experience: 161 });
  });
});
