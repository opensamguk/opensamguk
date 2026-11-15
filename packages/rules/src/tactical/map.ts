import type { BattleTerrain } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import type { DeepReadonly } from '../model/world';
import type { SupplyLedger } from '../campaign/supply';
import { supplyCellCost } from '../campaign/supply';

export function tacticalMap(
  world: WorldView,
  route: DeepReadonly<SupplyLedger['routes'][number]>,
  target: number,
  attackingNation: number | null,
) {
  const source = route.segments.flatMap((s) => s.cells.map((c) => ({ ...c, mode: s.mode })));
  if (route.to !== target) source.reverse();
  const distinct = source.filter((c, i) => source.findIndex((v) => v.cellId === c.cellId) === i).slice(-64);
  if (distinct.length < 3) throw Error('전장 배치 공간이 부족합니다.');
  const grid = (c: { x: number; y: number }) => ({ x: Math.round(c.x / 16), y: Math.round(c.y / 16) });
  const minX = Math.min(...distinct.map((c) => grid(c).x)),
    minY = Math.min(...distinct.map((c) => grid(c).y));
  const width = Math.max(...distinct.map((c) => grid(c).x)) - minX + 1,
    height = Math.max(...distinct.map((c) => grid(c).y)) - minY + 1;
  if (width > 64 || height > 64) throw Error('전장 범위가 64칸을 넘습니다.');
  const local = (c: { x: number; y: number }) => ({ x: grid(c).x - minX, y: grid(c).y - minY });
  const terrain: BattleTerrain[] = Array.from({ length: width * height }, () => 'plain');
  const cells = Array.from({ length: width * height }, () => ({ sourceTileId: '', spCost: 1, defendSpCost: 1 }));
  const defendingNation = world.cities[target]!.nationId;
  const all = world.campaign!.supplyLedger!.routes.flatMap((r) =>
    r.segments.flatMap((s) => s.cells.map((c) => ({ ...c, mode: s.mode }))),
  );
  for (const c of [...all, ...source]) {
    const p = local(c);
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
    const index = p.y * width + p.x;
    terrain[index] = c.mountain
      ? 'mountain'
      : ({ LAND: 'plain', FORD: 'ford', BRIDGE: 'bridge', RIVER: 'river', SEA: 'sea' } as const)[c.mode];
    const owner = c.ownerAnchorKey === null ? null : world.cities[c.ownerAnchorKey]?.nationId;
    const cost = (nation: number | null) =>
      supplyCellCost(
        c.mode,
        c.mountain,
        c.remote,
        owner != null &&
          nation !== null &&
          owner !== nation &&
          world.diplomacies.some(
            (d) =>
              d.state === 'WAR' &&
              ((d.nationA === owner && d.nationB === nation) || (d.nationB === owner && d.nationA === nation)),
          ),
      );
    cells[index] = { sourceTileId: c.cellId, spCost: cost(attackingNation), defendSpCost: cost(defendingNation) };
  }
  const edges: Array<[number, number]> = [];
  for (const segment of world.campaign!.supplyLedger!.routes.flatMap((r) => r.segments))
    for (let i = 1; i < segment.cells.length; i++) {
      const a = local(segment.cells[i - 1]!),
        b = local(segment.cells[i]!);
      if ([a, b].some((p) => p.x < 0 || p.y < 0 || p.x >= width || p.y >= height)) continue;
      if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) !== 1) continue;
      const pair: [number, number] = [a.y * width + a.x, b.y * width + b.x];
      pair.sort((x, y) => x - y);
      if (!edges.some((e) => e[0] === pair[0] && e[1] === pair[1])) edges.push(pair);
    }
  return {
    board: { width, height, terrain },
    cells,
    edges,
    path: distinct.map(local),
    exits: { attack: local(distinct[0]!), defend: local(distinct.at(-1)!) },
  };
}
