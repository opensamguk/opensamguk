import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  buildInitialWorld,
  featureProfileSchema,
  applySexLedger,
  initialReplayStateWithRegistry,
  ruleRegistry,
} from '../packages/rules/src/index';
import { loadSexLedger } from '../apps/engine/src/world/resources';
import { prepareInitialWorld } from '../apps/engine/src/world/persistence';
import { recruitGoods } from '../packages/rules/src/logistics/consumption';
import { expandedScenarioRow } from './expanded-resources';

const read = (path: string) => JSON.parse(readFileSync(new URL('../resources/' + path, import.meta.url), 'utf8'));

it('AC-INT-21·AC-P2-03·04·30 공개 확장 원생성이 승인된 규모·물자·패와 빈 전략 원장을 함께 만든다', async () => {
  const row = await expandedScenarioRow();
  const scenario = read('scenario/san10-191-v2.json');
  expect(scenario).toEqual({
    ...read('scenario/san10-191.json'),
    title: scenario.title,
    cityScale: {
      cities: [
        { city: '낙양', level: 9, ruin: true },
        { city: '장안', level: 9 },
      ],
    },
  });
  const profile = featureProfileSchema.parse(read('feature-profile/expanded-191-v4.json'));
  if (profile.version !== 3) throw Error('형식3 확장 설정이 필요합니다.');
  const initial = buildInitialWorld({
    seed: 'expanded-v4-public-profile',
    map: read('map/san10.json'),
    scenario: row.content,
    unitSet: read('unitset/expanded.json'),
    statRules: read('scenario/five-stats.json'),
    portraitMap: read('portraits/191-map.json'),
  });
  initial.ruleFeatures = profile.ruleFeatures;
  initial.scenarioKey = profile.scenarioKey;
  const settings = {
    name: '새 SAN10 확장 설정',
    turnTermMinutes: 60,
    endYear: 231,
    ruleFeatures: profile.ruleFeatures,
    featureData: profile.featureData,
  };
  expect(prepareInitialWorld(initial, settings).stateHash).toBe(prepareInitialWorld(initial, settings).stateHash);
  initial.generals = applySexLedger(initial, loadSexLedger());
  const replay = initialReplayStateWithRegistry(initial, ruleRegistry, {
    ...profile.featureData,
    policy: { version: 1, turnTermMinutes: 60 },
  });
  expect(initial.generals).toHaveLength(491);
  expect(initial.unitSet.crewTypes).toHaveLength(45);
  expect(replay.state.nationStrategy).toEqual({ version: 1, nations: {} });
  const cards = replay.state.stratagemCards!;
  expect(Object.values(cards.nations)).toHaveLength(21);
  expect(Object.values(cards.nations).every((row) => row.hand.length === 0)).toBe(true);
  expect(cards.config.deck).toHaveLength(8);
  expect(cards.config.deck.every((row) => row.weight === 1)).toBe(true);
  expect(cards.config).toMatchObject({
    capacity: 3,
    startHand: 0,
    trapCountsInCapacity: true,
    trap: { lossBp: 1000, atmosLoss: 10 },
    checkOnReserve: false,
    trapExpiryMonths: null,
  });
  expect(Object.values(replay.state.cities).find((row) => row.name === '낙양')).toMatchObject({
    level: 9,
    populationMax: 98792,
  });
  expect(Object.values(replay.state.cities).find((row) => row.name === '장안')).toMatchObject({ level: 9 });
  expect(recruitGoods(profile.featureData['logistics-v1'], 4, 100)).toEqual({ iron: 2, wood: 0, horses: 0 });
  expect(recruitGoods(profile.featureData['logistics-v1'], 5, 200)).toEqual({ iron: 4, wood: 20, horses: 0 });
});

it('AC-P2-03·04 형식3은 자원 다섯 칸·장비·패 설정·전략 기능을 빠짐없이 요구한다', () => {
  const profile = read('feature-profile/expanded-191-v4.json');
  for (const key of ['mapKey', 'scenarioKey', 'unitSetKey', 'statRulesKey', 'portraitMapKey']) {
    const invalid = structuredClone(profile);
    delete invalid[key];
    expect(featureProfileSchema.safeParse(invalid).success).toBe(false);
    invalid[key] = 'wrong@0';
    expect(featureProfileSchema.safeParse(invalid).success).toBe(false);
  }
  for (const key of ['equipment-v1', 'stratagem-cards-v1']) {
    const invalid = structuredClone(profile);
    delete invalid.featureData[key];
    expect(featureProfileSchema.safeParse(invalid).success).toBe(false);
  }
  for (const key of ['equipment-v1', 'stratagem-cards-v1', 'nation-strategy-v1'])
    expect(
      featureProfileSchema.safeParse({
        ...profile,
        ruleFeatures: profile.ruleFeatures.filter((f: string) => f !== key),
      }).success,
    ).toBe(false);
});
