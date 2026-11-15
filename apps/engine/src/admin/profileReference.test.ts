import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { featureProfileSchema, type ReplayOriginV3 } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { matchesPinnedFeatureProfile } from './profileReference';

it.each(['expanded-191-v1', 'expanded-191-v3', 'expanded-191-v7'])(
  'AC-INT-28 %s 수치 프로필의 고정 판과 설정을 대조한다',
  async (key) => {
    const profile = featureProfileSchema.parse(
      JSON.parse(await readFile(new URL(`../../../../resources/feature-profile/${key}.json`, import.meta.url), 'utf8')),
    );
    const reference = { key, contentHash: hashState(profile) };
    const selection = {
      scenario: profile.scenarioKey,
      map: profile.mapKey,
      unitSet: profile.version === 3 ? profile.unitSetKey : 'expanded',
      statRules: profile.version === 3 ? profile.statRulesKey : 'five-stats',
      portraitMap: profile.version === 3 ? profile.portraitMapKey : '191-map',
    };
    const origin = {
      featureData: {
        ...profile.featureData,
        policy: { version: 1, turnTermMinutes: 60 },
        'office-effects': { secretary: true },
      },
    } as unknown as ReplayOriginV3;
    expect(matchesPinnedFeatureProfile(origin, selection, reference)).toBe(true);
    const changed = structuredClone(origin);
    (changed.featureData!['lineage-v1'] as { version: number }).version = 99;
    expect(matchesPinnedFeatureProfile(changed, selection, reference)).toBe(false);
    expect(matchesPinnedFeatureProfile(origin, selection, { ...reference, contentHash: '0'.repeat(64) })).toBe(false);
  },
);
