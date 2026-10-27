import { expect, it } from 'vitest';
import { basemap, projectGeographicPoint, unprojectGeographicPoint } from './geography';
import { createCampaignDraft } from './campaignSeed';
it('projects WGS84 bounds without flipping latitude or longitude and round trips source city points', () => {
  const [w, s, e, n] = basemap.bounds as [number, number, number, number];
  expect(projectGeographicPoint(w, n)).toEqual({ x: 0, y: 0 });
  expect(projectGeographicPoint(e, s)).toEqual({ x: 1000, y: 700 });
  for (const place of basemap.places) {
    const p = projectGeographicPoint(place.longitude, place.latitude);
    const back = unprojectGeographicPoint(p.x, p.y);
    expect(Math.abs(back.latitude - place.latitude)).toBeLessThan(0.04);
    expect(Math.abs(back.longitude - place.longitude)).toBeLessThan(0.04);
  }
});
it('retains pinned GIS provenance and keeps one coordinate model for every site', () => {
  expect(basemap.source).toBe('Natural Earth v5.1.2');
  expect(basemap.land.length).toBeGreaterThan(100);
  expect(basemap.rivers.some((r) => r.path.length > 100)).toBe(true);
  expect(basemap.sources).toHaveLength(4);
  expect(basemap.relief.sha256).toBe('73eb7a00b182c702e69892332cbd380edc7aa00ccaf68ae0111deefb87303a0e');
  expect(basemap.relief.archiveVersion).toBe('2.0.0');
  expect(basemap.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256))).toBe(true);
  const draft = createCampaignDraft();
  expect(draft.sites.every((s) => s.x >= 0 && s.x <= 1000 && s.y >= 0 && s.y <= 700)).toBe(true);
  expect(draft.sites).toHaveLength(80);
  expect(draft.sites.every((s) => !('placement' in s) && !('sourcePlace' in s))).toBe(true);
});
