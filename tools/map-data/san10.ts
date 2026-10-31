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

// 화면 표식 크기(지도 단위, apps/web/src/main/siteMarkers.ts의 LEVEL_UNITS·FACILITY_UNITS와 같다).
// D-050: 초안의 일본 서부·시코쿠 지역 대표 거점은 『三國志』 왜인조의 나라 이름으로 내보낸다. 원문은 이 나라들의
// 위치를 적지 않아(其餘旁國遠絕，不可得詳) 거점 배정은 비정설을 따른 작업 기준이다. 초안은 조사 기록이라 그대로 둔다.
const SINO_KOREAN_NAMES: Record<string, string> = {
  이즈모: '투마국', // 投馬國
  기비: '지유국', // 支惟國
  이요: '이사국', // 伊邪國
  사누키: '파리국', // 巴利國
};

const LEVEL_UNITS = [5, 6, 4, 6, 6, 7, 8, 9, 11, 13];
const FACILITY_UNITS = { PASS: 6, PORT: 6, FIELD: 3.5 } as const;
const SPREAD_GAP = 4;
const SPREAD_LIMIT = 12;

// INT-20 사용자 요청: 표식이 붙거나 겹치는 거점을 띄운다. 두 표식 크기 합의 절반에 4단위를 더한 거리보다
// 가까우면 같은 거리만큼 서로 밀고, 거점마다 원래 자리에서 12단위 안에서만 움직인다. 좌표는 화면 표시용이라
// 규칙은 바뀌지 않는다. 정해진 순서로 반복해 늘 같은 결과가 나온다.
function spreadSites(sites: OperationalMapResource['sites']) {
  const units = (site: OperationalMapResource['sites'][number]) =>
    site.kind === 'CITY' ? (LEVEL_UNITS[site.level] ?? 7) : FACILITY_UNITS[site.kind];
  const origin = sites.map((site) => ({ ...site.position }));
  for (let round = 0; round < 60; round += 1) {
    let moved = false;
    for (let i = 0; i < sites.length; i += 1)
      for (let j = i + 1; j < sites.length; j += 1) {
        const a = sites[i]!.position;
        const b = sites[j]!.position;
        const need = (units(sites[i]!) + units(sites[j]!)) / 2 + SPREAD_GAP;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= need) continue;
        if (distance === 0) [dx, dy, distance] = [1, 0, 1];
        const push = Math.min(0.5, (need - distance) / 2);
        a.x -= (dx / distance) * push;
        a.y -= (dy / distance) * push;
        b.x += (dx / distance) * push;
        b.y += (dy / distance) * push;
        moved = true;
      }
    for (let i = 0; i < sites.length; i += 1) {
      const at = sites[i]!.position;
      const from = origin[i]!;
      const shift = Math.hypot(at.x - from.x, at.y - from.y);
      if (shift > SPREAD_LIMIT) {
        at.x = from.x + ((at.x - from.x) * SPREAD_LIMIT) / shift;
        at.y = from.y + ((at.y - from.y) * SPREAD_LIMIT) / shift;
      }
    }
    if (!moved) break;
  }
  for (const site of sites) site.position = { x: Math.round(site.position.x), y: Math.round(site.position.y) };
}

export function buildSan10Map(gisHash: string): OperationalMapResource {
  const draft: Draft = read('resources/map-drafts/san10/adopted-placement.json');
  const old = operationalMapSchema.parse(read('resources/map/integration.json'));
  const ids = new Map<string, string>();
  const inheritedOf = (site: Draft['sites'][number]) =>
    old.sites.find((row) => draft.operationalSiteAliases[row.id] === site.id);
  // D-049: SAN10에는 물길이 없어 항구 시설은 지도 자료에서 뺀다. 전장 표식은 남긴다.
  const kept = draft.sites.filter((site) => site.strategic || inheritedOf(site)?.kind !== 'PORT');
  const sites: OperationalMapResource['sites'] = kept.map((site) => {
    const inherited = inheritedOf(site);
    const common = { name: SINO_KOREAN_NAMES[site.name] ?? site.name, position: { ...site.position } };
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
  spreadSites(sites);
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
