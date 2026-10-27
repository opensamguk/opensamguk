import { describe, expect, it } from 'vitest';
import { parseCampaignDraft, previewCampaignRoute, validateCampaignDraft, type CampaignDraft } from './campaign';

function fixture(): CampaignDraft {
  return {
    format: 'campaign-map-draft',
    version: 3,
    name: '시험 지도',
    terrain: [],
    sites: [
      { id: 'city:a', name: '장안', kind: 'CITY', x: 100, y: 100, legacyCityId: 4 },
      { id: 'pass:b', name: '동관', kind: 'PASS', x: 200, y: 100 },
      { id: 'city:c', name: '낙양', kind: 'CITY', x: 300, y: 100, legacyCityId: 3 },
      { id: 'port:a', name: '서항', kind: 'PORT', x: 100, y: 150, parentCityId: 'city:a' },
      { id: 'port:c', name: '동항', kind: 'PORT', x: 300, y: 150, parentCityId: 'city:c' },
    ],
    routes: [
      { id: 'route:ab', from: 'city:a', to: 'pass:b', mode: 'LAND', direction: 'BOTH', enabled: true },
      {
        id: 'route:bc',
        from: 'pass:b',
        to: 'city:c',
        mode: 'LAND',
        direction: 'FORWARD',
        enabled: true,
      },
      {
        id: 'route:ac',
        from: 'city:a',
        to: 'city:c',
        mode: 'LAND',
        direction: 'FORWARD',
        enabled: true,
      },
      { id: 'route:ap', from: 'city:a', to: 'port:a', mode: 'LAND', direction: 'BOTH', enabled: true },
      { id: 'route:pc', from: 'port:c', to: 'city:c', mode: 'LAND', direction: 'BOTH', enabled: true },
      {
        id: 'route:river',
        from: 'port:a',
        to: 'port:c',
        mode: 'RIVER',
        direction: 'BOTH',
        enabled: true,
      },
    ],
  };
}
const errors = (m: unknown) => validateCampaignDraft(m).filter((i) => i.severity === 'error');
describe('campaign map file contract', () => {
  it('round trips typed sites, directions and terrain without v2 coercion', () => {
    const m = fixture();
    m.terrain.push({
      id: 'terrain:ridge',
      kind: 'MOUNTAIN',
      points: [
        { x: 1, y: 2 },
        { x: 20, y: 2 },
        { x: 10, y: 30 },
      ],
    });
    expect(parseCampaignDraft(JSON.stringify(m))).toEqual(m);
    expect(() => parseCampaignDraft(JSON.stringify({ ...m, version: 2 }))).toThrow();
    expect(() => parseCampaignDraft('{"__proto__":{}}')).toThrow();
    expect(() => parseCampaignDraft('x'.repeat(2_000_001))).toThrow('2 MB');
  });
  it.each([-1, 1.5, NaN, Infinity, 1001])('rejects invalid x coordinate %s', (n) => {
    const m = fixture();
    m.sites[0]!.x = n;
    expect(errors(m).length).toBeGreaterThan(0);
  });
  it('rejects duplicate and missing references, same endpoints and kind mismatch', () => {
    const m = fixture();
    m.sites.push({ ...m.sites[0]! });
    m.routes[0]!.from = 'city:missing';
    m.routes[1]!.to = m.routes[1]!.from;
    m.sites[1]!.kind = 'CITY';
    const messages = errors(m)
      .map((i) => i.message)
      .join('\n');
    expect(messages).toContain('중복 ID');
    expect(messages).toContain('거점이 없습니다');
    expect(messages).toContain('같은 거점');
    expect(messages).toContain('종류와 ID');
  });
  it('enforces port attachment, city keys and river endpoints', () => {
    const m = fixture();
    m.sites[3]!.parentCityId = 'pass:b';
    m.sites[2]!.legacyCityId = 4;
    m.routes[5]!.from = 'city:a';
    const messages = errors(m)
      .map((i) => i.message)
      .join('\n');
    expect(messages).toContain('소속 도시');
    expect(messages).toContain('도시 키 중복');
    expect(messages).toContain('항구끼리');
  });
  it('does not treat unconnected candidate sites as malformed files', () => {
    const m = fixture();
    m.routes = [];
    expect(errors(m)).toEqual([]);
    expect(validateCampaignDraft(m).some((i) => i.message.includes('5곳'))).toBe(true);
  });
  it('rejects reversed duplicate bidirectional links', () => {
    const m = fixture();
    const r = m.routes[0]!;
    m.routes.push({ ...r, id: 'route:duplicate', from: r.to, to: r.from });
    expect(errors(m).some((i) => i.message.includes('중복 연결'))).toBe(true);
  });
});
describe('map connectivity preview', () => {
  it('finds a deterministic fewest-link path without movement duration or speed', () => {
    const m = fixture();
    expect(previewCampaignRoute(m, 'city:a', 'city:c', false)).toEqual({
      sites: ['city:a', 'city:c'],
      routes: ['route:ac'],
    });
    expect(previewCampaignRoute(m, 'city:a', 'city:a', false)).toEqual({ sites: ['city:a'], routes: [] });
  });
  it('respects direction, disabled links, river filtering and unknown sites', () => {
    const m = fixture();
    expect(previewCampaignRoute(m, 'city:c', 'city:a', false)).toBeNull();
    expect(previewCampaignRoute(m, 'city:c', 'city:a', true)?.routes).toEqual(['route:pc', 'route:river', 'route:ap']);
    m.routes[2]!.enabled = false;
    expect(previewCampaignRoute(m, 'city:a', 'city:c', false)?.routes).toEqual(['route:ab', 'route:bc']);
    m.routes[1]!.enabled = false;
    expect(previewCampaignRoute(m, 'city:a', 'city:c', false)).toBeNull();
    expect(previewCampaignRoute(m, 'city:a', 'city:missing', true)).toBeNull();
  });
  it('ignores file order and refuses malformed maps', () => {
    const m = fixture();
    const expected = previewCampaignRoute(m, 'city:a', 'city:c', false);
    m.routes.reverse();
    expect(previewCampaignRoute(m, 'city:a', 'city:c', false)).toEqual(expected);
    m.routes[0]!.to = 'city:missing';
    expect(previewCampaignRoute(m, 'city:a', 'city:c', false)).toBeNull();
  });
});
