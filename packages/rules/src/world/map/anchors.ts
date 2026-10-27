import type { MapResource } from '../resources';
import { compileOperationalGraph, type OperationalMapResource } from './operational';

// 기존 명령은 cityKey와 인접 목록을 유지한다. 시설·지명은 전략 앵커로 변환하지 않는다.
export function operationalAnchors(map: OperationalMapResource) {
  const graph = new Map(compileOperationalGraph(map).map((row) => [row.cityKey, row.connections]));
  return map.sites
    .flatMap((site): Array<MapResource['cities'][number] & { kind: 'CITY' | 'PASS' }> => {
      if (site.kind !== 'CITY' && site.kind !== 'PASS') return [];
      const empty = { population: 0, agriculture: 0, commerce: 0, security: 0, defence: 0, wall: 0 };
      return [
        {
          id: site.anchorKey,
          name: site.name,
          kind: site.kind,
          level: site.kind === 'CITY' ? site.level : 0,
          region: site.region,
          position: { ...site.position },
          connections: graph.get(site.anchorKey)!,
          initial:
            site.kind === 'CITY'
              ? { ...site.initial }
              : { ...empty, defence: site.defence.initial, wall: site.wall.initial },
          max: site.kind === 'CITY' ? { ...site.max } : { ...empty, defence: site.defence.max, wall: site.wall.max },
        },
      ];
    })
    .sort((a, b) => a.id - b.id);
}
