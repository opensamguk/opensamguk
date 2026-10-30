import { readFileSync } from 'node:fs';
import { operationalMapSchema, type OperationalMapResource } from '../../packages/rules/src/world/map/operational';
import { scenarioSchema, type ScenarioResource } from '../../packages/rules/src/world/resources';

const root = new URL('../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
interface DraftSite {
  id: string;
  name: string;
  role: string;
  strategic: boolean;
  level?: number | null;
  position: { x: number; y: number };
  parentSiteId?: string;
}
interface Edge {
  id: string;
  from: string;
  to: string;
  mode: string;
}
interface Draft {
  sites: DraftSite[];
  connections: Edge[];
  proposedConnections: Edge[];
  operationalSiteAliases: Record<string, string>;
  canvas: { width: number; height: number };
  coordinateSystem: { bounds: [number, number, number, number] };
}

export function buildSan10Map(gisHash: string): OperationalMapResource {
  const draft: Draft = read('resources/map-drafts/san10/adopted-placement.json');
  const old = operationalMapSchema.parse(read('resources/map/integration.json'));
  const ids = new Map<string, string>();
  const sites: OperationalMapResource['sites'] = draft.sites.map((site) => {
    const inherited = old.sites.find((row) => draft.operationalSiteAliases[row.id] === site.id);
    const common = { name: site.name, position: { ...site.position } };
    if (!site.strategic) {
      if (!inherited || (inherited.kind !== 'PORT' && inherited.kind !== 'FIELD'))
        throw Error(`시설 대응 없음: ${site.id}`);
      ids.set(site.id, inherited.id);
      return { ...inherited, ...common };
    }
    const key = inherited && 'anchorKey' in inherited ? inherited.anchorKey : 1000 + Number(site.id.slice(1));
    const kind = site.role === 'PASS' ? 'PASS' : 'CITY';
    const id = `${kind.toLowerCase()}:${key}`;
    ids.set(site.id, id);
    if (kind === 'PASS') {
      if (inherited?.kind !== 'PASS') throw Error(`관문 대응 없음: ${site.name}`);
      return { ...inherited, ...common, id };
    }
    if (inherited?.kind === 'CITY') return { ...inherited, ...common, id, level: site.level ?? inherited.level };
    const level = site.level ?? 2;
    return {
      ...common,
      id,
      kind: 'CITY',
      anchorKey: key,
      level,
      region: 1,
      initial: {
        population: level * 2500,
        agriculture: level * 50,
        commerce: level * 50,
        security: 100,
        defence: level * 250,
        wall: level * 250,
      },
      max: {
        population: level * 50000,
        agriculture: level * 1000,
        commerce: level * 1000,
        security: 2000,
        defence: level * 2000,
        wall: level * 2000,
      },
    };
  });
  for (const site of sites)
    if (site.kind === 'PORT') {
      const parent = draft.operationalSiteAliases[site.parentCityId];
      if (!parent || !ids.has(parent)) throw Error(`항구 소속 없음: ${site.id}`);
      site.parentCityId = ids.get(parent)!;
    }
  const routes = [...draft.connections, ...draft.proposedConnections].map((edge) => ({
    id: edge.id.startsWith('route:') ? edge.id : `route:san10-${edge.id.toLowerCase().replaceAll('.', '-')}`,
    from: ids.get(edge.from)!,
    to: ids.get(edge.to)!,
    mode: 'LAND' as const,
    direction: 'BOTH' as const,
    enabled: true,
  }));
  return operationalMapSchema.parse({
    version: 3,
    id: 'san10',
    name: 'SAN10 통합 지도',
    canvas: draft.canvas,
    basemap: {
      source: 'natural-earth-5.1.2',
      projection: 'WGS84 plate carree',
      sha256: gisHash,
      bounds: draft.coordinateSystem.bounds,
    },
    defaults: old.defaults,
    sites,
    routes,
  });
}

export function buildSan10Scenarios(map: OperationalMapResource) {
  const draft: Draft = read('resources/map-drafts/san10/adopted-placement.json');
  const old = operationalMapSchema.parse(read('resources/map/integration.json'));
  const source = scenarioSchema.parse(read('resources/scenario/integration191.json'));
  const renamed = new Map(
    old.sites.map((site) => [
      site.name,
      draft.sites.find((row) => row.id === draft.operationalSiteAliases[site.id])!.name,
    ]),
  );
  const name = (value: string) => renamed.get(value) ?? value;
  const historical: ScenarioResource = {
    ...source,
    id: 'san10-191',
    title: 'SAN10 역사 · 191년 군웅할거',
    nation: source.nation.map((row) => {
      const copy = structuredClone(row);
      copy[8] = row[8].map(name);
      return copy;
    }),
    general: source.general.map((row) => {
      const copy = structuredClone(row);
      if (copy[4] !== null) copy[4] = name(copy[4]);
      return copy;
    }),
  };
  // 예전에는 표시뿐이던 네 거점도 원본의 소유국으로 돌려준다. 수도는 현재 정식 대응을 유지한다.
  const original = scenarioSchema.parse(read('resources/scenario/1030.json'));
  const existingOwners = new Set(historical.nation.flatMap((row) => row[8]));
  original.nation.forEach((row, index) => {
    for (const oldName of row[8]) {
      const target = name(oldName);
      if (!existingOwners.has(target) && map.sites.some((site) => 'anchorKey' in site && site.name === target)) {
        historical.nation[index]![8].push(target);
        existingOwners.add(target);
      }
    }
  });
  const empty: ScenarioResource = {
    ...historical,
    id: 'san10-empty',
    title: 'SAN10 공백지 · 180년 난세 개막',
    startYear: 180,
    nation: [],
    diplomacy: [],
    general: historical.general.map((row) => {
      const copy = structuredClone(row);
      copy[3] = 0;
      copy[8] = 0;
      return copy;
    }),
  };
  return { historical: scenarioSchema.parse(historical), empty: scenarioSchema.parse(empty) };
}
