import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { operationalMapSchema, type OperationalMapResource } from '../../packages/rules/src/world/map/operational';
import { mapSchema } from '../../packages/rules/src/world/resources';
import { createCampaignDraft } from '../../apps/web/src/mapEditor/campaignSeed';

const root = new URL('../../', import.meta.url);
const legacy = mapSchema.parse(JSON.parse(readFileSync(new URL('resources/map/che.json', root), 'utf8')));
const source = new URL('apps/web/src/mapEditor/geodata/natural-earth.json', root);

// 새 도시의 게임 경제 초깃값이다. 역사 자료의 인구·세입으로 주장하지 않는다.
const additions: Record<number, { region: number }> = {
  95: { region: 1 },
  96: { region: 3 },
  97: { region: 5 },
  98: { region: 7 },
  99: { region: 1 },
};
const initial = { population: 5000, agriculture: 100, commerce: 100, security: 100, defence: 500, wall: 500 };
const max = { population: 100000, agriculture: 2000, commerce: 2000, security: 2000, defence: 4000, wall: 4000 };

// 명시적 게임 경로. 지형 원본의 도로망이나 한대 교통을 재현한 자료가 아니다.
const corridors: Array<[number, number, string?]> = [
  [99, 8, 'field:90'],
  [8, 17, 'field:77'],
  [17, 9],
  [9, 36],
  [36, 37],
  [37, 21],
  [1, 9, 'field:78'],
  [1, 18],
  [1, 70],
  [70, 95],
  [95, 35],
  [95, 23],
  [35, 17],
  [23, 3],
  [3, 71],
  [71, 2],
  [71, 19],
  [18, 19, 'field:81'],
  [19, 2],
  [19, 39],
  [39, 21],
  [39, 38],
  [38, 2],
  [38, 20],
  [2, 10],
  [20, 10],
  [20, 11],
  [21, 83],
  [83, 11],
  [4, 100],
  [100, 42],
  [42, 73],
  [73, 3],
  [4, 101],
  [101, 10],
  [4, 41],
  [41, 40, 'field:85'],
  [40, 22],
  [22, 96],
  [96, 40, 'field:84'],
  [40, 43, 'field:86'],
  [43, 75],
  [75, 24],
  [75, 102],
  [102, 44],
  [44, 87],
  [87, 5],
  [24, 25],
  [25, 51],
  [10, 51],
  [51, 6],
  [6, 13, 'field:89'],
  [25, 45],
  [44, 27],
  [27, 45],
  [45, 13, 'field:88'],
  [5, 28],
  [28, 48],
  [48, 97],
  [97, 50],
  [50, 29],
  [29, 30],
  [30, 54],
  [54, 53],
  [53, 13],
  [53, 14],
  [14, 30],
  [14, 15],
  [15, 98],
  [98, 57],
  [57, 31],
  [98, 29],
  [11, 56, 'field:82'],
  [56, 7],
];

export function buildOperationalMap(): OperationalMapResource {
  const draft = createCampaignDraft();
  const sites: OperationalMapResource['sites'] = draft.sites.map((site) => {
    const common = {
      id: site.id,
      name: site.kind === 'PASS' && site.id === 'pass:75' ? '양평관' : site.name,
      position: { x: site.x, y: site.y },
    };
    if (site.kind === 'PORT') return { ...common, kind: 'PORT', parentCityId: site.parentCityId! };
    if (site.kind === 'FIELD') return { ...common, kind: 'FIELD' };
    const key = Number(site.id.split(':')[1]);
    const old = legacy.cities.find((city) => city.id === key);
    if (site.kind === 'PASS')
      return {
        ...common,
        kind: 'PASS',
        anchorKey: key,
        ...(old ? { legacyCityId: old.id } : {}),
        region: old?.region ?? 4,
        defence: { initial: old?.initial.defence ?? 5000, max: old?.max.defence ?? 10000 },
        wall: { initial: old?.initial.wall ?? 5000, max: old?.max.wall ?? 10000 },
      };
    if (!old && !additions[key]) throw new Error(`도시 게임 수치가 없습니다: ${site.id}`);
    return {
      ...common,
      kind: 'CITY',
      anchorKey: key,
      ...(old ? { legacyCityId: old.id } : {}),
      level: old?.level ?? 2,
      region: old?.region ?? additions[key]!.region,
      initial: { ...(old?.initial ?? initial) },
      max: { ...(old?.max ?? max) },
    };
  });
  const anchorId = (key: number) => {
    const site = sites.find((site) => 'anchorKey' in site && site.anchorKey === key);
    if (!site) throw new Error(`연결 앵커가 없습니다: ${key}`);
    return site.id;
  };
  const routes: OperationalMapResource['routes'] = corridors.map(([from, to, via]) => ({
    id: `route:land-${from}-${to}`,
    from: anchorId(from),
    to: anchorId(to),
    mode: 'LAND',
    direction: 'BOTH',
    enabled: true,
    ...(via ? { via: [via] } : {}),
  }));
  // 관도는 황하 도하 길목이며 추가 이동 거점이 아니다.
  routes.push({
    id: 'route:bridge-1-2',
    from: 'city:1',
    to: 'city:2',
    mode: 'BRIDGE',
    direction: 'BOTH',
    enabled: true,
    via: ['field:80'],
  });
  routes.push({ id: 'route:ford-6-52', from: 'city:6', to: 'city:52', mode: 'FORD', direction: 'BOTH', enabled: true });
  for (const [from, to, via] of [
    [13, 52, 'field:91'],
    [52, 15],
    [15, 56, 'field:92'],
    [56, 7],
    [7, 31],
  ] as const)
    routes.push({
      id: `route:river-${from}-${to}`,
      from: `city:${from}`,
      to: `city:${to}`,
      mode: 'RIVER',
      direction: 'BOTH',
      enabled: true,
      portIds: [`port:${from}`, `port:${to}`],
      ...(via ? { via: [via] } : {}),
    });
  const geo = JSON.parse(readFileSync(source, 'utf8')) as { bounds: [number, number, number, number] };
  return operationalMapSchema.parse({
    version: 3,
    id: 'integration',
    name: '통합판 삼국 지도',
    canvas: { width: 1000, height: 700 },
    basemap: {
      source: 'natural-earth-5.1.2',
      projection: 'WGS84 plate carree',
      sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
      bounds: geo.bounds,
    },
    defaults: { trust: legacy.defaults.trust, supplyState: legacy.defaults.supplyState },
    sites,
    routes,
  });
}

export function legacyAnchorCorrespondence() {
  return buildOperationalMap().sites.flatMap((site) =>
    'legacyCityId' in site && site.legacyCityId !== undefined
      ? [
          {
            legacyCityId: site.legacyCityId,
            oldName: legacy.cities.find((city) => city.id === site.legacyCityId)!.name,
            siteId: site.id,
            name: site.name,
            kind: site.kind,
          },
        ]
      : [],
  );
}
