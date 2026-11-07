import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { readCampaignArmyTypes } from '../apps/engine/src/campaignState';
import { checkStoredReplayFormat } from '../apps/engine/src/features';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';
import { initializeIntegrationResources } from './integration-resources';
const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
beforeAll(async () => {
  await initializeIntegrationResources(db);
});
afterAll(async () => {
  await db.$disconnect();
});

describe('AC-INT-06 휘하 저장 경계', () => {
  it('운영 병종을 생성 원장과 대조하고 사본 변조를 턴 처리 전에 거부한다', async () => {
    const initial = await loadInitialWorldFromDb(db, {
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'immutable-army-source',
    });
    initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
    const origin = {
      version: 3,
      initial,
      initialStateHash: 'hash',
      resourceHash: 'hash',
      featureData: { policy: { version: 1, turnTermMinutes: 60 } },
    };
    const row = JSON.parse(JSON.stringify({ unitSet: initial.unitSet, replayOrigin: origin }));
    const types = readCampaignArmyTypes(row);
    expect(types).toContain(1100);
    expect(types).not.toContain(1000);
    const checked = checkStoredReplayFormat({ ...row, replayFormat: 3, ruleFeatures: initial.ruleFeatures });
    expect(checked).toBe(row.replayOrigin);
    expect(readCampaignArmyTypes(row, checked)).toEqual(types);
    expect(() => readCampaignArmyTypes({ ...row, replayOrigin: structuredClone(row.replayOrigin) }, checked)).toThrow(
      '잠근 월드와 다릅니다',
    );
    row.unitSet.crewTypes[1].id = 9999;
    expect(() => readCampaignArmyTypes(row)).toThrow('생성 기록과 다릅니다');
    expect(() => readCampaignArmyTypes(row, checked)).toThrow('생성 기록과 다릅니다');
    expect(
      readCampaignArmyTypes(JSON.parse(JSON.stringify({ unitSet: initial.unitSet, replayOrigin: origin }))),
    ).toEqual(types);
    expect(() => readCampaignArmyTypes({ unitSet: row.unitSet, replayOrigin: null })).toThrow();
  });
});
