import { describe, expect, it } from 'vitest';
import { compileOperationalGraph, operationalMapSchema, type OperationalMapResource } from './operational';

const values = { population: 100, agriculture: 100, commerce: 100, security: 100, defence: 100, wall: 100 };
function fixture(): OperationalMapResource {
  return {
    version: 3,
    id: 'integration',
    name: '운영 계약 검사',
    canvas: { width: 1000, height: 700 },
    basemap: {
      source: 'natural-earth-5.1.2',
      projection: 'WGS84 plate carree',
      sha256: 'a'.repeat(64),
      bounds: [94, 17, 132.571428571429, 44],
    },
    defaults: { trust: 80, supplyState: 1 },
    sites: [
      {
        id: 'city:1',
        name: '도시1',
        kind: 'CITY',
        anchorKey: 1,
        legacyCityId: 1,
        level: 1,
        region: 1,
        position: { x: 100, y: 200 },
        initial: { ...values },
        max: { ...values },
      },
      {
        id: 'city:2',
        name: '도시2',
        kind: 'CITY',
        anchorKey: 2,
        legacyCityId: 2,
        level: 1,
        region: 1,
        position: { x: 300, y: 400 },
        initial: { ...values },
        max: { ...values },
      },
      {
        id: 'pass:99',
        name: '관문',
        kind: 'PASS',
        anchorKey: 99,
        position: { x: 200, y: 300 },
        region: 1,
        defence: { initial: 100, max: 500 },
        wall: { initial: 100, max: 500 },
      },
      { id: 'port:1', name: '항구1', kind: 'PORT', parentCityId: 'city:1', position: { x: 110, y: 200 } },
      { id: 'port:2', name: '항구2', kind: 'PORT', parentCityId: 'city:2', position: { x: 310, y: 400 } },
      { id: 'field:1', name: '전장', kind: 'FIELD', position: { x: 200, y: 210 } },
    ],
    routes: [
      {
        id: 'route:1',
        from: 'city:1',
        to: 'pass:99',
        mode: 'LAND',
        direction: 'BOTH',
        enabled: true,
        via: ['field:1', 'port:1'],
      },
      { id: 'route:2', from: 'pass:99', to: 'city:2', mode: 'LAND', direction: 'BOTH', enabled: true },
    ],
  };
}

describe('AC-INT-02 운영 지도 v3', () => {
  it('도시와 관문만 기존 cityKey 앵커를 가지며 표식 경유는 빈 이동 턴을 만들지 않는다', () => {
    const map = fixture(),
      before = structuredClone(map);
    expect(compileOperationalGraph(map)).toEqual([
      { siteId: 'city:1', cityKey: 1, kind: 'CITY', connections: [99] },
      { siteId: 'city:2', cityKey: 2, kind: 'CITY', connections: [99] },
      { siteId: 'pass:99', cityKey: 99, kind: 'PASS', connections: [1, 2] },
    ]);
    expect(map).toEqual(before);
    const reversed = structuredClone(map);
    reversed.sites.reverse();
    reversed.routes.reverse();
    expect(compileOperationalGraph(reversed)).toEqual(compileOperationalGraph(map));
  });

  it('방향·차단은 운영 연결에 반영하고 시각적 경유 관문으로 우회하지 않는다', () => {
    const map = fixture();
    map.routes[0]!.direction = 'FORWARD';
    map.routes[1]!.enabled = false;
    expect(compileOperationalGraph(map).map((row) => row.connections)).toEqual([[99], [], []]);
    map.routes[0]!.via = ['pass:99'];
    expect(operationalMapSchema.safeParse(map).success).toBe(false);
  });

  it('수로는 양쪽 도시의 서로 다른 항구 시설을 요구하며 시설을 이동 목표로 삼지 않는다', () => {
    const map = fixture();
    map.routes = [
      {
        id: 'route:river',
        from: 'city:1',
        to: 'city:2',
        mode: 'RIVER',
        direction: 'BOTH',
        enabled: true,
        portIds: ['port:1', 'port:2'],
      },
    ];
    expect(operationalMapSchema.safeParse(map).success).toBe(true);
    expect(compileOperationalGraph(map)[0]!.connections).toEqual([2]);
    for (const portIds of [undefined, ['port:2', 'port:1'], ['port:1', 'port:1']] as const) {
      const invalid = structuredClone(map);
      Reflect.set(invalid.routes[0]!, 'portIds', portIds);
      expect(operationalMapSchema.safeParse(invalid).success).toBe(false);
    }
    map.routes[0]!.to = 'port:2';
    expect(operationalMapSchema.safeParse(map).success).toBe(false);
  });

  it.each([
    [
      '거점 중복',
      (m: OperationalMapResource) => {
        m.sites.push(structuredClone(m.sites[0]!));
      },
    ],
    [
      '앵커 중복',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[2]!, 'anchorKey', 1);
      },
    ],
    [
      '기존 대응 중복',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[1]!, 'legacyCityId', 1);
      },
    ],
    [
      '종류와 ID',
      (m: OperationalMapResource) => {
        m.sites[2]!.id = 'city:99';
      },
    ],
    [
      '항구 귀속',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[3]!, 'parentCityId', 'pass:99');
      },
    ],
    [
      '항구 독립 앵커',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[3]!, 'anchorKey', 123);
      },
    ],
    [
      '전장 독립 앵커',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[5]!, 'anchorKey', 124);
      },
    ],
    [
      '관문 경제',
      (m: OperationalMapResource) => {
        Reflect.set(m.sites[2]!, 'population', 1);
      },
    ],
    [
      '차단 경로의 참조',
      (m: OperationalMapResource) => {
        m.routes[0]!.enabled = false;
        m.routes[0]!.to = 'pass:missing';
      },
    ],
    [
      '연결 중복 ID',
      (m: OperationalMapResource) => {
        m.routes.push(structuredClone(m.routes[0]!));
      },
    ],
    [
      '전장 이동 목표',
      (m: OperationalMapResource) => {
        m.routes[0]!.to = 'field:1';
      },
    ],
    [
      '육로의 수로 시설',
      (m: OperationalMapResource) => {
        m.routes[0]!.portIds = ['port:1', 'port:2'];
      },
    ],
    [
      '자기 연결',
      (m: OperationalMapResource) => {
        m.routes[0]!.to = m.routes[0]!.from;
      },
    ],
    [
      '지도 범위 역전',
      (m: OperationalMapResource) => {
        m.basemap.bounds = [132, 17, 94, 44];
      },
    ],
  ])('%s를 게시 가능한 운영 자원으로 받지 않는다', (_name, change) => {
    const map = fixture();
    change(map);
    expect(operationalMapSchema.safeParse(map).success).toBe(false);
  });
});
