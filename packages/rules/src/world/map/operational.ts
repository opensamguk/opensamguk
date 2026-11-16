import { z } from 'zod';
import { territoryGridSchema } from '@opensamguk/shared';

const id = z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const name = z.string().trim().min(1).max(60);
const natural = z.number().int().min(0).max(2147483647);
const anchor = natural.min(1);
const position = z.strictObject({ x: z.number().finite().min(0).max(4096), y: z.number().finite().min(0).max(4096) });
const common = { id, name, position, description: z.string().max(600).optional() };
const values = z.strictObject({
  population: natural,
  agriculture: natural,
  commerce: natural,
  security: natural,
  defence: natural,
  wall: natural,
});
const fortification = z.strictObject({ initial: natural, max: natural });
const site = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('CITY'),
    anchorKey: anchor,
    legacyCityId: anchor.optional(),
    parentCityKey: anchor.optional(),
    level: z.number().int().min(0).max(9),
    region: z.number().int().min(1).max(16),
    initial: values,
    max: values,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('PASS'),
    anchorKey: anchor,
    legacyCityId: anchor.optional(),
    region: z.number().int().min(1).max(16),
    defence: fortification,
    wall: fortification,
  }),
  z.strictObject({ ...common, kind: z.literal('PORT'), parentCityId: id }),
  z.strictObject({
    ...common,
    kind: z.literal('FIELD'),
    anchorKey: anchor.optional(),
    region: z.number().int().min(1).max(16).optional(),
  }),
]);
const route = z.strictObject({
  id,
  from: id,
  to: id,
  mode: z.enum(['LAND', 'FORD', 'BRIDGE', 'RIVER', 'SEA']),
  direction: z.enum(['BOTH', 'FORWARD']),
  enabled: z.boolean(),
  // 표식 경유는 선의 모양만 바꾸며 전략 거점이나 추가 이동 턴을 만들지 않는다.
  via: z.array(id).max(200).optional(),
  portIds: z.tuple([id, id]).optional(),
});

export const operationalMapSchema = z
  .strictObject({
    version: z.literal(3),
    id,
    name: name.max(100),
    regionScheme: z.literal('province-191').optional(),
    siteClassification: z.literal('d096').optional(),
    capturableFields: z.literal(true).optional(),
    canvas: z.strictObject({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }),
    basemap: z.strictObject({
      source: z.literal('natural-earth-5.1.2'),
      projection: z.literal('WGS84 plate carree'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bounds: z.tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
      ]),
    }),
    defaults: z.strictObject({ trust: z.number().min(0).max(100), supplyState: z.union([z.literal(0), z.literal(1)]) }),
    sites: z.array(site).min(1).max(500),
    territory: territoryGridSchema.optional(),
    routes: z.array(route).max(2000),
  })
  .superRefine((map, context) => {
    const fail = (path: PropertyKey[], message: string) => context.addIssue({ code: 'custom', path, message });
    const [west, south, east, north] = map.basemap.bounds;
    if (west >= east || south >= north) fail(['basemap', 'bounds'], '지도 범위의 순서를 확인하세요.');
    if (map.canvas.width * map.canvas.height > 4194304) fail(['canvas'], '지도 면적이 너무 큽니다.');
    const ids = new Set<string>(),
      anchors = new Set<number>(),
      names = new Set<string>(),
      legacy = new Set<number>();
    const sites = new Map(map.sites.map((row) => [row.id, row]));
    map.sites.forEach((row, index) => {
      const path = ['sites', index];
      if (row.position.x > map.canvas.width || row.position.y > map.canvas.height)
        fail([...path, 'position'], '거점이 지도 범위를 벗어났습니다.');
      if (ids.has(row.id)) fail([...path, 'id'], '거점 ID가 중복됩니다.');
      ids.add(row.id);
      if (
        !row.id.startsWith(`${row.kind.toLowerCase()}:`) &&
        !(map.siteClassification === 'd096' && row.kind === 'FIELD' && row.id.startsWith('city:'))
      )
        fail([...path, 'id'], '거점 종류와 ID가 다릅니다.');
      if (
        row.kind === 'FIELD' &&
        (map.capturableFields === true
          ? row.anchorKey === undefined || row.region === undefined
          : row.anchorKey !== undefined || row.region !== undefined)
      )
        fail(path, '전장 점령 판의 앵커와 지역을 확인하세요.');
      if (row.kind === 'CITY' || row.kind === 'PASS' || (row.kind === 'FIELD' && row.anchorKey !== undefined)) {
        if (anchors.has(row.anchorKey!)) fail([...path, 'anchorKey'], 'cityKey 앵커가 중복됩니다.');
        anchors.add(row.anchorKey!);
        if (names.has(row.name)) fail([...path, 'name'], '전략 거점 이름이 중복됩니다.');
        names.add(row.name);
        if ('legacyCityId' in row && row.legacyCityId !== undefined) {
          if (legacy.has(row.legacyCityId)) fail([...path, 'legacyCityId'], '기존 도시 대응이 중복됩니다.');
          legacy.add(row.legacyCityId);
        }
        if (row.kind === 'CITY') {
          if (row.parentCityKey !== undefined) {
            const parent = map.sites.find((site) => site.kind === 'CITY' && site.anchorKey === row.parentCityKey);
            const localMajor = map.sites.some(
              (site) => site.kind === 'CITY' && site.level >= 5 && site.region === row.region,
            );
            if (
              map.siteClassification !== 'd096' ||
              row.level !== 2 ||
              parent?.kind !== 'CITY' ||
              parent.level < 5 ||
              (localMajor && parent.region !== row.region)
            )
              fail([...path, 'parentCityKey'], '부속 현의 부모 도시를 확인하세요.');
          }
          for (const key of Object.keys(values.shape) as Array<keyof typeof row.initial>)
            if (row.initial[key] > row.max[key]) fail([...path, 'initial', key], '초기값이 최대치를 넘습니다.');
        } else if (row.kind === 'PASS') {
          for (const key of ['defence', 'wall'] as const)
            if (row[key].initial > row[key].max) fail([...path, key, 'initial'], '관문 초기 방어가 최대치를 넘습니다.');
        }
      } else if (row.kind === 'PORT' && sites.get(row.parentCityId)?.kind !== 'CITY') {
        fail([...path, 'parentCityId'], '항구는 존재하는 도시에 속해야 합니다.');
      }
    });
    if (!map.sites.some((row) => row.kind === 'CITY' && (map.siteClassification !== 'd096' || row.level >= 4)))
      fail(['sites'], '경제 도시가 하나 이상 필요합니다.');
    const territoryCities = new Set(
      map.sites.flatMap((row) =>
        row.kind === 'CITY' && isStrategicSite(map, row) && row.parentCityKey === undefined ? [row.anchorKey] : [],
      ),
    );
    if (map.territory?.owner.some((key) => key !== -1 && !territoryCities.has(key)))
      fail(['territory', 'owner'], '영지 칸의 독립 거점을 확인하세요.');
    const routes = new Set<string>();
    map.routes.forEach((edge, index) => {
      const path = ['routes', index];
      if (routes.has(edge.id)) fail([...path, 'id'], '연결 ID가 중복됩니다.');
      routes.add(edge.id);
      if (!edge.id.startsWith('route:')) fail([...path, 'id'], '연결 ID 접두사를 확인하세요.');
      if (edge.from === edge.to) fail(path, '같은 거점을 연결할 수 없습니다.');
      const from = sites.get(edge.from),
        to = sites.get(edge.to);
      for (const key of ['from', 'to'] as const) {
        const endpoint = sites.get(edge[key]);
        if (
          !endpoint ||
          (!('anchorKey' in endpoint) && !(map.siteClassification === 'd096' && endpoint.kind === 'FIELD'))
        )
          fail([...path, key], '연결 목표는 도시나 관문이어야 합니다.');
      }
      for (const [offset, via] of (edge.via ?? []).entries()) {
        const point = sites.get(via);
        if (
          !point ||
          point.kind === 'CITY' ||
          point.kind === 'PASS' ||
          (map.capturableFields && point.kind === 'FIELD')
        )
          fail([...path, 'via', offset], '시각적 경유점은 항구 시설이나 전장 표시여야 합니다.');
      }
      if (new Set(edge.via ?? []).size !== (edge.via ?? []).length) fail([...path, 'via'], '경유 표식이 중복됩니다.');
      if (edge.mode === 'RIVER' && !(map.siteClassification === 'd096' && edge.portIds === undefined)) {
        if (!edge.portIds || from?.kind !== 'CITY' || to?.kind !== 'CITY')
          fail([...path, 'portIds'], '수로는 양쪽 도시의 항구 시설이 필요합니다.');
        else
          for (const [offset, endpoint] of [edge.from, edge.to].entries()) {
            const port = sites.get(edge.portIds[offset]!);
            if (port?.kind !== 'PORT' || port.parentCityId !== endpoint)
              fail([...path, 'portIds', offset], '수로 항구와 소속 도시가 다릅니다.');
          }
      } else if (edge.portIds !== undefined)
        fail([...path, 'portIds'], '수로 외 연결에는 수로 항구를 지정하지 않습니다.');
    });
  });

export type OperationalMapResource = z.infer<typeof operationalMapSchema>;
export type OperationalSite = OperationalMapResource['sites'][number];
export type StrategicSite =
  | Extract<OperationalSite, { kind: 'CITY' | 'PASS' }>
  | (Extract<OperationalSite, { kind: 'FIELD' }> & { anchorKey: number; region: number });

export function isStrategicSite(map: OperationalMapResource, site: OperationalSite): site is StrategicSite {
  return (
    site.kind === 'PASS' ||
    (site.kind === 'CITY' && (map.siteClassification !== 'd096' || [1, 2, 4, 5, 6, 7, 8, 9].includes(site.level))) ||
    (map.capturableFields === true &&
      site.kind === 'FIELD' &&
      site.anchorKey !== undefined &&
      site.region !== undefined)
  );
}

export function compileOperationalGraph(input: unknown) {
  const map = operationalMapSchema.parse(input);
  const anchors = map.sites.filter((row) => isStrategicSite(map, row));
  const byId = new Map(anchors.map((row) => [row.id, row]));
  const links = new Map(anchors.map((row) => [row.anchorKey, new Set<number>()]));
  const adjacent = new Map(map.sites.map((row) => [row.id, new Set<string>()]));
  for (const edge of map.routes) {
    if (!edge.enabled) continue;
    adjacent.get(edge.from)!.add(edge.to);
    if (edge.direction === 'BOTH') adjacent.get(edge.to)!.add(edge.from);
  }
  // 작은 거점과 전장은 다음 전략 거점까지 경유한다. 관문을 넘어가는 지름길은 만들지 않는다.
  for (const origin of anchors) {
    const seen = new Set([origin.id]);
    const queue = [origin.id];
    for (let i = 0; i < queue.length; i++)
      for (const id of adjacent.get(queue[i]!)!) {
        if (seen.has(id)) continue;
        seen.add(id);
        const target = byId.get(id);
        if (target) links.get(origin.anchorKey)!.add(target.anchorKey);
        else queue.push(id);
      }
  }
  return anchors
    .sort((a, b) => a.anchorKey - b.anchorKey)
    .map((row) => ({
      siteId: row.id,
      cityKey: row.anchorKey,
      kind: row.kind,
      connections: [...links.get(row.anchorKey)!].sort((a, b) => a - b),
    }));
}
