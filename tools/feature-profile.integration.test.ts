import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadFeatureProfile, loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { prepareInitialWorld } from '../apps/engine/src/world/persistence';
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

describe('AC-P2-30·31·32·33 확장 생성 설정', () => {
  it.each(['expanded-191-v1', 'expanded-191-v2', 'expanded-191-v3'])(
    '%s의 승인한 수치로 실제 491명 원생성을 결정적으로 준비한다',
    async (key) => {
      const profile = await loadFeatureProfile(key);
      expect(profile.contentHash).toBe(hashState(profile.value));
      expect(profile.value.ruleFeatures).toHaveLength(
        key === 'expanded-191-v1' ? 13 : key === 'expanded-191-v2' ? 14 : 15,
      );
      expect(profile.value.ruleFeatures.includes('battle-affinity-v2')).toBe(key === 'expanded-191-v3');
      const lineage = profile.value.featureData['lineage-v1'];
      expect(lineage).toMatchObject({ birth: { chanceBp: 500 }, limits: { maxGenerals: 2500 } });
      expect(profile.value.featureData['logistics-v1'].specialties).toHaveLength(9);
      const initial = await loadInitialWorldFromDb(db, {
        scenario: 'integration191',
        map: 'integration',
        unitSet: 'basic',
        statRules: 'five-stats',
        portraitMap: '191-map',
        seed: 'expanded-profile-g1',
      });
      initial.ruleFeatures = [...profile.value.ruleFeatures];
      const before = hashState(initial);
      const options = {
        name: '확장 설정 검증',
        turnTermMinutes: 5,
        endYear: 231,
        ruleFeatures: profile.value.ruleFeatures,
        featureData: profile.value.featureData,
      };
      const first = prepareInitialWorld(initial, options);
      const second = prepareInitialWorld(initial, options);
      expect(initial.generals).toHaveLength(491);
      expect(first.stateHash).toBe(second.stateHash);
      expect(hashState(initial)).toBe(before);
    },
  );
});
