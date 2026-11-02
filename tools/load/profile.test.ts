import { beforeAll, describe, expect, it } from 'vitest';
import { loadInitialWorld } from '../../apps/engine/src/world/resources';
import type { WorldInit } from '../../packages/rules/src/index';
import { LOAD_RESOURCES } from './contract';
import { assertLoadProfile } from './profile';

let formal: WorldInit;
beforeAll(async () => {
  formal = await loadInitialWorld({ ...LOAD_RESOURCES, seed: 'load-profile-unit' });
});

describe('T3-11 현재 정식 자원 프로필', () => {
  it('실제491ID/21국/53도시8관문6항구13전장을확인한다', () => {
    const profile = assertLoadProfile(formal);
    expect(profile.historicalGeneralIds).toHaveLength(491);
    expect(profile).toMatchObject({ nations: 21, cities: 53, passes: 8, ports: 6, fields: 13 });
  });

  it.each(['general', 'nation', 'city', 'port', 'field', 'stats', 'scenario'] as const)(
    '%s프로필차이를평균값이나구판으로대체하지않는다',
    (kind) => {
      const changed = structuredClone(formal);
      if (kind === 'general') changed.generals.pop();
      if (kind === 'nation') changed.nations.pop();
      if (kind === 'city') changed.cities.pop();
      if (kind === 'port' || kind === 'field')
        changed.operationalMap!.sites = changed.operationalMap!.sites.filter(
          (site) => site.kind !== (kind === 'port' ? 'PORT' : 'FIELD'),
        );
      if (kind === 'stats') Object.assign(changed.statRules, { count: 3 });
      if (kind === 'scenario') changed.scenarioKey = '1030';
      expect(() => assertLoadProfile(changed)).toThrow('LOAD_FORMAL_PROFILE_REQUIRED');
    },
  );

  it('중복ID를총491행이라는이유로통과시키지않는다', () => {
    const changed = structuredClone(formal);
    changed.generals[1]!.id = changed.generals[0]!.id;
    expect(() => assertLoadProfile(changed)).toThrow('LOAD_FORMAL_PROFILE_REQUIRED');
  });
});
