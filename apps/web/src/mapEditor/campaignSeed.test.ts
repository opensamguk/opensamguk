import { expect, it } from 'vitest';
import { validateCampaignDraft } from '@opensamguk/rules/resources';
import { createCampaignDraft } from './campaignSeed';
it('keeps the selected 53 cities, 8 passes, 6 port facilities and 13 field candidates distinct', () => {
  const map = createCampaignDraft();
  expect(['CITY', 'PASS', 'PORT', 'FIELD'].map((k) => map.sites.filter((s) => s.kind === k).length)).toEqual([
    53, 8, 6, 13,
  ]);
  expect(validateCampaignDraft(map).filter((i) => i.severity === 'error')).toEqual([]);
  expect(map.sites.find((s) => s.id === 'pass:75')?.name).toBe('양평');
  expect(map.sites.find((s) => s.id === 'city:99')?.name).toBe('양평');
  expect(map.sites.some((s) => s.id === 'city:60')).toBe(false);
  map.sites[0]!.name = '변경';
  expect(createCampaignDraft().sites[0]!.name).not.toBe('변경');
});
