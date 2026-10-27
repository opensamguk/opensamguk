import { z } from 'zod';

// File-editing draft only. Runtime resource publication is tracked by INT-02.
export const SITE_KINDS = ['CITY', 'PASS', 'PORT', 'FIELD'] as const;
export const ROUTE_MODES = ['LAND', 'FORD', 'BRIDGE', 'RIVER'] as const;
export const TERRAIN_KINDS = ['PLAIN', 'FOREST', 'MOUNTAIN', 'WATER'] as const;
const id = z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const point = z.object({ x: z.number().int().min(0).max(1000), y: z.number().int().min(0).max(700) }).strict();
const site = point
  .extend({
    id,
    name: z.string().trim().min(1).max(60),
    kind: z.enum(SITE_KINDS),
    legacyCityId: z.number().int().positive().max(1_000_000).optional(),
    parentCityId: id.optional(),
  })
  .strict();
const route = z
  .object({
    id,
    from: id,
    to: id,
    mode: z.enum(ROUTE_MODES),
    direction: z.enum(['BOTH', 'FORWARD']),
    enabled: z.boolean(),
  })
  .strict();
export const campaignDraftSchema = z
  .object({
    format: z.literal('campaign-map-draft'),
    version: z.literal(3),
    name: z.string().trim().min(1).max(100),
    sites: z.array(site).min(1).max(500),
    routes: z.array(route).max(2000),
    terrain: z
      .array(z.object({ id, kind: z.enum(TERRAIN_KINDS), points: z.array(point).min(3).max(200) }).strict())
      .max(500),
  })
  .strict();
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;
export type CampaignSite = CampaignDraft['sites'][number];
export type CampaignRoute = CampaignDraft['routes'][number];
export type DraftIssue = { severity: 'error' | 'warning'; message: string };
export const MAX_DRAFT_BYTES = 2_000_000;

export function validateCampaignDraft(input: unknown): DraftIssue[] {
  const parsed = campaignDraftSchema.safeParse(input);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({ severity: 'error', message: `${i.path.join('.')}: ${i.message}` }));
  const map = parsed.data;
  const issues: DraftIssue[] = [];
  const fail = (message: string) => issues.push({ severity: 'error', message });
  for (const entries of [map.sites, map.routes, map.terrain]) {
    const ids = new Set<string>();
    for (const item of entries) {
      if (ids.has(item.id)) fail(`중복 ID ${item.id}`);
      ids.add(item.id);
    }
  }
  const sites = new Map(map.sites.map((s) => [s.id, s]));
  const legacy = new Set<number>();
  for (const s of map.sites) {
    if (!s.id.startsWith(`${s.kind.toLowerCase()}:`)) fail(`종류와 ID가 다릅니다 ${s.id}`);
    if (s.kind === 'CITY') {
      if (s.legacyCityId !== undefined) {
        if (legacy.has(s.legacyCityId)) fail(`도시 키 중복 ${s.legacyCityId}`);
        legacy.add(s.legacyCityId);
      }
    } else if (s.legacyCityId !== undefined) fail(`도시 외 거점의 도시 키 ${s.id}`);
    if (s.kind === 'PORT' && sites.get(s.parentCityId ?? '')?.kind !== 'CITY')
      fail(`항구의 소속 도시가 없습니다 ${s.id}`);
    if (s.kind !== 'PORT' && s.parentCityId !== undefined) fail(`항구 외 거점의 소속 도시 ${s.id}`);
  }
  for (const t of map.terrain) {
    if (!t.id.startsWith('terrain:')) fail(`지형 ID 접두사가 다릅니다 ${t.id}`);
    const area = t.points.reduce((sum, p, i) => {
      const q = t.points[(i + 1) % t.points.length]!;
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    if (area === 0 || new Set(t.points.map((p) => `${p.x},${p.y}`)).size !== t.points.length)
      fail(`지형 꼭짓점이나 면적을 확인하세요 ${t.id}`);
  }
  const links = new Set<string>();
  const connected = new Set<string>();
  for (const r of map.routes) {
    if (!r.id.startsWith('route:')) fail(`경로 ID 접두사가 다릅니다 ${r.id}`);
    if (!sites.has(r.from) || !sites.has(r.to)) fail(`경로의 거점이 없습니다 ${r.id}`);
    if (r.from === r.to) fail(`같은 거점을 잇는 경로 ${r.id}`);
    if (r.mode === 'RIVER' && (sites.get(r.from)?.kind !== 'PORT' || sites.get(r.to)?.kind !== 'PORT'))
      fail(`수로는 항구끼리 연결합니다 ${r.id}`);
    const ends = r.direction === 'BOTH' ? [r.from, r.to].sort() : [r.from, r.to];
    const key = `${r.mode}:${r.direction}:${ends.join('>')}`;
    if (links.has(key)) fail(`중복 연결 ${r.id}`);
    links.add(key);
    if (r.enabled) {
      connected.add(r.from);
      connected.add(r.to);
    }
  }
  const isolated = map.sites.filter((s) => !connected.has(s.id));
  if (isolated.length) issues.push({ severity: 'warning', message: `활성 경로가 없는 거점 ${isolated.length}곳` });
  issues.push({
    severity: 'warning',
    message: '위치·지형·연결 검토용 초안입니다. 운영 지도 게시는 아직 연결하지 않았습니다.',
  });
  return issues;
}

export function parseCampaignDraft(text: string): CampaignDraft {
  if (text.length > MAX_DRAFT_BYTES || new TextEncoder().encode(text).length > MAX_DRAFT_BYTES)
    throw new Error('지도 파일은 2 MB 이하로 고르세요.');
  const input: unknown = JSON.parse(text);
  const issues = validateCampaignDraft(input).filter((i) => i.severity === 'error');
  if (issues.length)
    throw new Error(
      issues
        .slice(0, 5)
        .map((i) => i.message)
        .join('\n'),
    );
  return campaignDraftSchema.parse(input);
}

export type RoutePreview = { sites: string[]; routes: string[] };
// Connectivity preview for map editing only. Game movement keeps the current main rules.
export function previewCampaignRoute(
  map: CampaignDraft,
  from: string,
  to: string,
  allowRiver: boolean,
): RoutePreview | null {
  if (validateCampaignDraft(map).some((i) => i.severity === 'error')) return null;
  if (!map.sites.some((s) => s.id === from) || !map.sites.some((s) => s.id === to)) return null;
  const pending = [from];
  const seen = new Set([from]);
  const previous = new Map<string, { site: string; route: string }>();
  const routes = [...map.routes].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i]!;
    if (current === to) {
      const path = [to];
      const steps: string[] = [];
      while (path[0] !== from) {
        const prev = previous.get(path[0]!);
        if (!prev) return null;
        path.unshift(prev.site);
        steps.unshift(prev.route);
      }
      return { sites: path, routes: steps };
    }
    for (const r of routes) {
      if (!r.enabled || (r.mode === 'RIVER' && !allowRiver)) continue;
      const target = r.from === current ? r.to : r.to === current && r.direction === 'BOTH' ? r.from : null;
      if (!target || seen.has(target)) continue;
      seen.add(target);
      previous.set(target, { site: current, route: r.id });
      pending.push(target);
    }
  }
  return null;
}
