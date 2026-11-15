import { assignCountyParents } from '../../packages/rules/src/cityAffiliation';
import { operationalAnchors } from '../../packages/rules/src/world/map/anchors';
import type { InitialCity } from '../../packages/rules/src/world/bootstrap';
import { readFileSync } from 'node:fs';
import { operationalMapSchema, type OperationalMapResource } from '../../packages/rules/src/world/map/operational';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../resources/map/san10-expanded-${name}.json`, import.meta.url), 'utf8'));
const small = read('small-sites') as { sites: { name: string; level: number; category: string }[] };
const moves = read('site-moves') as { moves: { id: string; to: { x: number; y: number } }[] };
const additions = read('site-additions') as { sites: OperationalMapResource['sites'] };
const routeAdditions = read('route-additions') as { routes: { from: string; to: string }[] };
const edits = read('site-edits') as { levels: Record<string, number>; renames: { from: string; to: string }[] };
const descriptions = read('descriptions') as { descriptions: Record<string, string> };
type RouteChange = { id: string; from: string; to: string; mode: OperationalMapResource['routes'][number]['mode'] };
const plan = read('route-plan') as {
  cut: RouteChange[];
  add: RouteChange[];
  mode: RouteChange[];
  level: { name: string; level: number }[];
};

// 정리한 설명은 최종 미리보기의 ID별 원문을 고정한다. 길 기록은 개명 전 이름을 쓴다.
export function applyExpandedEdits(input: OperationalMapResource): OperationalMapResource {
  const map = structuredClone(input);
  map.siteClassification = 'd096';
  map.capturableFields = true;
  map.sites = map.sites.map((site) => {
    const classification = small.sites.find((row) => row.name === site.name);
    const position = moves.moves.find((row) => row.id === site.id)?.to ?? site.position;
    if (classification && ['싸움터', '명소'].includes(classification.category))
      return {
        id: site.id,
        name: site.name,
        position,
        kind: 'FIELD' as const,
        anchorKey: 'anchorKey' in site ? site.anchorKey : undefined,
        region: 'region' in site ? site.region : undefined,
      };
    return {
      ...site,
      position,
      ...(site.kind === 'CITY' && classification
        ? { level: classification.category === '수' ? 1 : classification.level }
        : {}),
      ...(site.kind === 'CITY' && site.name === '이주' ? { level: 4, region: 16 } : {}),
    };
  });
  map.sites.push(...structuredClone(additions.sites));
  const byName = new Map(map.sites.map((site) => [site.name, site]));
  const site = (name: string) => {
    const found = byName.get(name);
    if (!found) throw Error(`손질할 거점 누락: ${name}`);
    return found;
  };
  for (const [name, level] of Object.entries(edits.levels)) {
    const target = site(name);
    if (target.kind !== 'CITY') throw Error(`도시 단계 변경 대상 확인: ${name}`);
    target.level = level;
  }
  for (const row of plan.level) {
    const target = site(row.name);
    if (target.kind !== 'CITY') throw Error(`도시 단계 변경 대상 확인: ${row.name}`);
    target.level = row.level;
  }
  for (const { from, to } of routeAdditions.routes) {
    const keys = [from, to].map((id) => id.split(':')[1]).sort((a, b) => Number(a) - Number(b));
    map.routes.push({ id: `route:add-${keys.join('-')}`, from, to, mode: 'LAND', direction: 'BOTH', enabled: true });
  }
  for (const row of plan.cut) {
    if (!map.routes.some((route) => route.id === row.id)) throw Error(`끊을 길 누락: ${row.id}`);
    map.routes = map.routes.filter((route) => route.id !== row.id);
  }
  for (const row of plan.mode) {
    const route = map.routes.find((route) => route.id === row.id);
    if (!route) throw Error(`종류를 바꿀 길 누락: ${row.id}`);
    route.mode = row.mode;
  }
  for (const row of plan.add)
    map.routes.push({
      id: row.id,
      from: site(row.from).id,
      to: site(row.to).id,
      mode: row.mode,
      direction: 'BOTH',
      enabled: true,
    });
  for (const row of edits.renames) site(row.from).name = row.to;
  for (const target of map.sites) {
    const description = descriptions.descriptions[target.id];
    if (typeof description !== 'string') throw Error(`거점 설명 누락: ${target.id}`);
    target.description = description;
  }
  const anchors = operationalAnchors(map).map((anchor) => ({
    ...anchor,
    cityKey: anchor.id,
    x: anchor.position.x,
    y: anchor.position.y,
    nationId: null,
  })) as unknown as InitialCity[];
  assignCountyParents(anchors);
  for (const site of map.sites)
    if (site.kind === 'CITY') {
      const parent = anchors.find((city) => city.cityKey === site.anchorKey)?.parentCityKey;
      if (parent != null) site.parentCityKey = parent;
    }
  return operationalMapSchema.parse(map);
}
