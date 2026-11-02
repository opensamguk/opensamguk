import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const name = z.string().trim().min(1).max(60);
const natural = z.number().int().min(0).max(2147483647);
const anchor = natural.min(1);
const position = z.strictObject({ x: z.number().finite().min(0).max(4096), y: z.number().finite().min(0).max(4096) });
const common = { id, name, position };
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
    level: z.number().int().min(1).max(8),
    region: z.number().int().min(1).max(8),
    initial: values,
    max: values,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('PASS'),
    anchorKey: anchor,
    legacyCityId: anchor.optional(),
    region: z.number().int().min(1).max(8),
    defence: fortification,
    wall: fortification,
  }),
  z.strictObject({ ...common, kind: z.literal('PORT'), parentCityId: id }),
  z.strictObject({ ...common, kind: z.literal('FIELD') }),
]);
const route = z.strictObject({
  id,
  from: id,
  to: id,
  mode: z.enum(['LAND', 'FORD', 'BRIDGE', 'RIVER']),
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
      if (!row.id.startsWith(`${row.kind.toLowerCase()}:`)) fail([...path, 'id'], '거점 종류와 ID가 다릅니다.');
      if (row.kind === 'CITY' || row.kind === 'PASS') {
        if (anchors.has(row.anchorKey)) fail([...path, 'anchorKey'], 'cityKey 앵커가 중복됩니다.');
        anchors.add(row.anchorKey);
        if (names.has(row.name)) fail([...path, 'name'], '전략 거점 이름이 중복됩니다.');
        names.add(row.name);
        if (row.legacyCityId !== undefined) {
          if (legacy.has(row.legacyCityId)) fail([...path, 'legacyCityId'], '기존 도시 대응이 중복됩니다.');
          legacy.add(row.legacyCityId);
        }
        if (row.kind === 'CITY') {
          for (const key of Object.keys(values.shape) as Array<keyof typeof row.initial>)
            if (row.initial[key] > row.max[key]) fail([...path, 'initial', key], '초기값이 최대치를 넘습니다.');
        } else {
          for (const key of ['defence', 'wall'] as const)
            if (row[key].initial > row[key].max) fail([...path, key, 'initial'], '관문 초기 방어가 최대치를 넘습니다.');
        }
      } else if (row.kind === 'PORT' && sites.get(row.parentCityId)?.kind !== 'CITY') {
        fail([...path, 'parentCityId'], '항구는 존재하는 도시에 속해야 합니다.');
      }
    });
    if (!map.sites.some((row) => row.kind === 'CITY')) fail(['sites'], '경제 도시가 하나 이상 필요합니다.');
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
        if (!endpoint || !('anchorKey' in endpoint)) fail([...path, key], '연결 목표는 도시나 관문이어야 합니다.');
      }
      for (const [offset, via] of (edge.via ?? []).entries()) {
        const point = sites.get(via);
        if (!point || point.kind === 'CITY' || point.kind === 'PASS')
          fail([...path, 'via', offset], '시각적 경유점은 항구 시설이나 전장 표시여야 합니다.');
      }
      if (new Set(edge.via ?? []).size !== (edge.via ?? []).length) fail([...path, 'via'], '경유 표식이 중복됩니다.');
      if (edge.mode === 'RIVER') {
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
export type StrategicSite = Extract<OperationalSite, { kind: 'CITY' | 'PASS' }>;

export function compileOperationalGraph(input: unknown) {
  const map = operationalMapSchema.parse(input);
  const anchors = map.sites.filter((row): row is StrategicSite => 'anchorKey' in row);
  const byId = new Map(anchors.map((row) => [row.id, row]));
  const links = new Map(anchors.map((row) => [row.anchorKey, new Set<number>()]));
  for (const edge of map.routes) {
    if (!edge.enabled) continue;
    const from = byId.get(edge.from)!.anchorKey,
      to = byId.get(edge.to)!.anchorKey;
    links.get(from)!.add(to);
    if (edge.direction === 'BOTH') links.get(to)!.add(from);
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
