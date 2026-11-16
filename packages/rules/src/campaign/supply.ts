import { commandMoveTargets, commandAttackTargets } from '../commandPaths';
import { z } from 'zod';
import type { WorldView, WorldState } from '../model/world';
import type { OperationalMapResource } from '../world/map/operational';
import { isStrategicSite } from '../world/map/operational';
import { supplyTerrain } from '../world/map/territory';
import type { CampaignUnitState } from './state';

const natural = z.number().int().min(0).max(2_147_483_647);
const id = natural.min(1);
const cell = z.strictObject({
  cellId: z.string().min(1),
  pathCellIndex: natural,
  x: natural,
  y: natural,
  mountain: z.boolean(),
  remote: z.boolean(),
  ownerAnchorKey: id.nullable(),
});
export const supplyLedgerSchema = z.strictObject({
  version: z.literal(1),
  cellSize: z.union([z.literal(8), z.literal(16)]),
  routes: z.array(
    z.strictObject({
      routeId: z.string().min(1),
      from: id,
      to: id,
      segments: z
        .array(
          z.strictObject({
            routeId: z.string().min(1),
            mode: z.enum(['LAND', 'FORD', 'BRIDGE', 'RIVER', 'SEA']),
            cells: z.array(cell).min(2),
          }),
        )
        .min(1),
    }),
  ),
});
export const unitSupplySchema = z.strictObject({
  feature: z.literal('march-supply-v1'),
  unit: z.literal('SP'),
  loaded: natural.min(1).max(100),
  remaining: natural.max(100),
  originCityKey: id,
});
export const marchSupplyArgs = {
  supplyLoad: z.number().int().min(1).max(100).optional(),
  routeId: z.string().min(1).max(32000).optional(),
  routeRevision: z.string().min(1).optional(),
  ownershipRevision: z.string().min(1).optional(),
  diplomacyRevision: z.string().min(1).optional(),
};
export type SupplyLedger = z.infer<typeof supplyLedgerSchema>;

// 원장 판 비교용 내용 해시. 비용·소유·권한은 이 값과 무관하게 엔진에서 재계산한다.
function revision(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify(value)) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function buildSupplyLedger(map: OperationalMapResource): SupplyLedger {
  const anchors = map.sites.filter((site) => isStrategicSite(map, site));
  const byId = new Map(map.sites.map((site) => [site.id, site]));
  const economic = anchors
    .filter((site) => site.kind === 'CITY' && site.parentCityKey === undefined)
    .sort((a, b) => a.anchorKey - b.anchorKey);
  const terrain = supplyTerrain(map);
  // The original square ledger is preserved for worlds created without INT-28 geography.
  const legacyCell = (x: number, y: number) => {
    const px = x * 16,
      py = y * 16;
    const ownSite = anchors.find(
      (site) => Math.round(site.position.x / 16) === x && Math.round(site.position.y / 16) === y,
    );
    const owner =
      ownSite ??
      [...economic].sort(
        (a, b) =>
          (a.position.x - px) ** 2 + (a.position.y - py) ** 2 - ((b.position.x - px) ** 2 + (b.position.y - py) ** 2) ||
          a.anchorKey - b.anchorKey,
      )[0];
    return {
      cellId: `cell:${x}:${y}`,
      x: Math.min(map.canvas.width, px),
      y: Math.min(map.canvas.height, py),
      mountain: false,
      remote: false,
      ownerAnchorKey: owner?.anchorKey ?? null,
    };
  };
  const edges = map.routes
    .filter((route) => route.enabled)
    .flatMap((route) => {
      const points = [route.from, ...(route.via ?? []), route.to].map((key) => byId.get(key)!.position);
      const cells: Array<Omit<z.infer<typeof cell>, 'pathCellIndex'>> = [];
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1]!,
          b = points[index]!;
        if (terrain) {
          const start = terrain.tileAt(a),
            end = terrain.tileAt(b);
          const cuts = [0, 1];
          for (const key of ['u', 'v'] as const) {
            const lo = Math.min(start[key], end[key]),
              hi = Math.max(start[key], end[key]);
            for (let boundary = Math.floor(lo) + 1; boundary < hi; boundary++)
              cuts.push((boundary - start[key]) / (end[key] - start[key]));
          }
          cuts.sort((a, b) => a - b);
          const add = (t: number) => {
            const u = Math.floor(start.u + (end.u - start.u) * t);
            const v = Math.floor(start.v + (end.v - start.v) * t);
            const next = terrain.cellAt(u, v, route.mode === 'SEA', route.mode === 'SEA' || route.mode === 'RIVER');
            if (cells.at(-1)?.cellId !== next.cellId) cells.push(next);
          };
          add(0);
          for (let i = 1; i < cuts.length; i++) {
            const before = cuts[i - 1]!,
              after = cuts[i]!;
            if (after - before > 1e-10) add((before + after) / 2);
          }
          add(1);
          continue;
        }
        const x0 = Math.round(a.x / 16),
          y0 = Math.round(a.y / 16);
        const x1 = Math.round(b.x / 16),
          y1 = Math.round(b.y / 16);
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let step = 0; step <= steps; step++) {
          const next = legacyCell(
            Math.round(x0 + ((x1 - x0) * step) / steps),
            Math.round(y0 + ((y1 - y0) * step) / steps),
          );
          if (cells.at(-1)?.cellId !== next.cellId) cells.push(next);
        }
      }
      // 같은 칸 안의 두 거점도 출발·도착을 원장에 남긴다. 실제 비용은 중복 칸을 건너뛴다.
      if (cells.length === 1) cells.push({ ...cells[0]! });
      const indexed = cells.map((point, pathCellIndex) => ({ ...point, pathCellIndex }));
      const segment = { routeId: route.id, mode: route.mode, cells: indexed };
      return [
        { from: route.from, to: route.to, segment },
        ...(route.direction === 'BOTH'
          ? [{ from: route.to, to: route.from, segment: { ...segment, cells: [...indexed].reverse() } }]
          : []),
      ];
    })
    .sort((a, b) => a.segment.routeId.localeCompare(b.segment.routeId));
  const routes: SupplyLedger['routes'] = [];
  const anchorIds = new Map(anchors.map((site) => [site.id, site.anchorKey]));
  for (const origin of anchors) {
    const pending = [
      { at: origin.id, segments: [] as SupplyLedger['routes'][number]['segments'], visited: [origin.id] },
    ];
    for (let offset = 0; offset < pending.length; offset++) {
      const current = pending[offset]!;
      for (const edge of edges.filter((edge) => edge.from === current.at)) {
        if (current.visited.includes(edge.to)) continue;
        const segments = [...current.segments, edge.segment];
        const target = anchorIds.get(edge.to);
        if (target !== undefined) {
          routes.push({
            routeId: segments.map((segment) => segment.routeId).join('/'),
            from: origin.anchorKey,
            to: target,
            segments,
          });
        } else if (!pending.some((entry) => entry.at === edge.to && entry.segments[0]?.mode === segments[0]!.mode)) {
          pending.push({ at: edge.to, segments, visited: [...current.visited, edge.to] });
        }
      }
    }
  }
  return supplyLedgerSchema.parse({ version: 1, cellSize: terrain ? 8 : 16, routes });
}

export function verifySupplyLedger(value: unknown, map: OperationalMapResource | undefined, enabled: boolean): void {
  if (!enabled) {
    if (value !== undefined) throw new Error('행군 보급을 끈 월드에 칸 원장이 있습니다.');
    return;
  }
  if (!map || JSON.stringify(supplyLedgerSchema.parse(value)) !== JSON.stringify(buildSupplyLedger(map)))
    throw new Error('행군 칸 원장이 생성 지도의 경로·소유 칸 자료와 다릅니다.');
}

export function supplyCellCost(
  mode: SupplyLedger['routes'][number]['segments'][number]['mode'],
  mountain: boolean,
  remote: boolean,
  hostile: boolean,
): number {
  const base = mode === 'FORD' || mode === 'SEA' ? 2 : 1;
  return Math.min(12, Math.max(base, mountain ? 3 : 0) * (remote ? 2 : 1) * (hostile ? 2 : 1));
}

export function resolveMarchRoute(
  world: WorldView,
  unit: Readonly<CampaignUnitState>,
  cityKey: number,
  options: z.infer<z.ZodObject<typeof marchSupplyArgs>> & { cityPath?: readonly number[] } = {},
) {
  const ledger = world.campaign?.supplyLedger;
  if (!ledger) return null;
  const owner = world.generals[unit.ownerId]!;
  const candidates = ledger.routes.filter((route) => route.from === owner.cityKey && route.to === cityKey);
  if (world.cities[owner.cityKey]?.state != null && owner.cityKey !== cityKey) {
    const selected = options.cityPath
      ? { path: options.cityPath }
      : [...commandMoveTargets(world, owner.id), ...commandAttackTargets(world, owner.id)].find(
          (target) => target.cityKey === cityKey && target.blockedBy === null,
        );
    if (selected) {
      const parts = selected.path
        .slice(1)
        .map(
          (to, index) =>
            ledger.routes
              .filter((route) => route.from === selected.path[index] && route.to === to)
              .sort((a, b) => a.routeId.localeCompare(b.routeId))[0],
        );
      if (parts.some((part) => !part)) throw new Error('행군 경로 원장이 없습니다.');
      candidates.splice(0, candidates.length, {
        routeId: parts.map((part) => part!.routeId).join('/'),
        from: owner.cityKey,
        to: cityKey,
        segments: parts.flatMap((part) => part!.segments),
      });
    }
  }
  if (!candidates.length) {
    const queue = [{ at: owner.cityKey, parts: [] as (typeof ledger.routes)[number][] }];
    const visited = new Set([owner.cityKey]);
    for (let index = 0; index < queue.length; index++) {
      const step = queue[index]!;
      for (const edge of ledger.routes.filter((route) => route.from === step.at)) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        const parts = [...step.parts, edge];
        if (edge.to === cityKey)
          candidates.push({
            routeId: parts.map((part) => part.routeId).join('/'),
            from: owner.cityKey,
            to: cityKey,
            segments: parts.flatMap((part) => part.segments),
          });
        else queue.push({ at: edge.to, parts });
      }
      if (candidates.length) break;
    }
  }
  const route = options.routeId ? candidates.find((route) => route.routeId === options.routeId) : candidates[0];
  if (!route) throw new Error('행군 경로가 없습니다.');
  return route;
}

export function previewMarchSupply(
  world: WorldView,
  unit: Readonly<CampaignUnitState>,
  cityKey: number,
  options: z.infer<z.ZodObject<typeof marchSupplyArgs>> & { cityPath?: readonly number[] } = {},
) {
  const route = resolveMarchRoute(world, unit, cityKey, options);
  if (!route) return null;
  const owner = world.generals[unit.ownerId]!;
  const loaded = unit.supply?.loaded ?? options.supplyLoad ?? 100;
  const remaining = unit.supply?.remaining ?? loaded;
  const owners = Object.values(world.cities)
    .sort((a, b) => a.cityKey - b.cityKey)
    .map((city) => [city.cityKey, city.nationId]);
  const diplomacy = world.diplomacies
    .map(({ nationA, nationB, state, untilTick }) => ({ nationA, nationB, state, untilTick }))
    .sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB);
  let estimatedCost = 0,
    available = remaining,
    previous: string | undefined;
  let exhaustedAt: null | {
    routeId: string;
    pathCellIndex: number;
    cellId: string;
    x: number;
    y: number;
    required: number;
    available: number;
  } = null;
  let last: { x: number; y: number } = { x: world.cities[owner.cityKey]!.x, y: world.cities[owner.cityKey]!.y };
  for (const segment of route.segments) {
    for (const point of segment.cells) {
      const pathCellIndex = point.pathCellIndex;
      if (previous === undefined || previous === point.cellId) {
        previous = point.cellId;
        continue;
      }
      previous = point.cellId;
      const nationId = point.ownerAnchorKey === null ? null : world.cities[point.ownerAnchorKey]?.nationId;
      const hostile =
        nationId != null &&
        owner.nationId !== null &&
        nationId !== owner.nationId &&
        world.diplomacies.some(
          (relation) =>
            relation.state === 'WAR' &&
            ((relation.nationA === owner.nationId && relation.nationB === nationId) ||
              (relation.nationB === owner.nationId && relation.nationA === nationId)),
        );
      const required = supplyCellCost(segment.mode, point.mountain, point.remote, hostile);
      estimatedCost += required;
      if (!exhaustedAt && available < required)
        exhaustedAt = {
          routeId: segment.routeId,
          pathCellIndex,
          cellId: point.cellId,
          x: point.x,
          y: point.y,
          required,
          available,
        };
      if (!exhaustedAt) {
        available -= required;
        last = point;
      }
    }
  }
  return {
    routeId: route.routeId,
    feature: 'march-supply-v1' as const,
    unit: 'SP' as const,
    loaded,
    remaining,
    estimatedCost,
    estimatedRemaining: Math.max(0, remaining - estimatedCost),
    riceCost: unit.supply ? 0 : Math.ceil(unit.troops / 100) * loaded,
    reachable: exhaustedAt === null,
    exhaustedAt,
    routeRevision: revision(route),
    ownershipRevision: revision(owners),
    diplomacyRevision: revision(diplomacy),
    last,
  };
}

export function applyMarchSupply(
  state: WorldState,
  units: readonly Readonly<CampaignUnitState>[],
  cityKey: number,
  options: z.infer<z.ZodObject<typeof marchSupplyArgs>> & { cityPath?: readonly number[] },
) {
  const unit = marchForce(units);
  const preview = previewMarchSupply(state, unit, cityKey, options);
  if (!preview) return true;
  if (state.campaign!.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
  state.campaign!.revision++;
  const owner = state.generals[unit.ownerId]!;
  const stock = state.cityResources!.cities[String(owner.cityKey)]!;
  if (stock.rice < preview.riceCost) throw new Error('출병 도시의 쌀이 부족합니다.');
  stock.rice -= preview.riceCost;
  unit.supply = {
    feature: 'march-supply-v1',
    unit: 'SP',
    loaded: preview.loaded,
    remaining: preview.estimatedRemaining,
    originCityKey: unit.supply?.originCityKey ?? owner.cityKey,
  };
  const ids = new Set(units.map((row) => row.id));
  for (const row of state.campaign!.units) if (ids.has(row.id)) row.supply = { ...unit.supply };
  if (preview.reachable) return true;
  const friendly = Object.values(state.cities).filter(
    (city) =>
      owner.nationId !== null && city.nationId === owner.nationId && city.kind !== 'FIELD' && city.kind !== 'PASS',
  );
  const origin = Object.values(state.cities).find(
    (city) =>
      owner.nationId !== null && city.nationId === owner.nationId && city.cityKey === unit.supply!.originCityKey,
  );
  const capital = friendly.find((city) => city.cityKey === state.nations[owner.nationId!]?.capitalCityKey);
  const distance = (city: { x: number; y: number }) =>
    state.campaign!.supplyLedger?.cellSize === 8
      ? (city.x - preview.last.x) ** 2 + (city.y - preview.last.y) ** 2
      : Math.max(
          Math.abs(Math.round(city.x / 16) - Math.round(preview.last.x / 16)),
          Math.abs(Math.round(city.y / 16) - Math.round(preview.last.y / 16)),
        );
  const nearest = friendly.sort((a, b) => distance(a) - distance(b) || a.cityKey - b.cityKey)[0];
  const destination = origin ?? capital ?? nearest;
  const returning = new Set([unit.ownerId, ...units.map((row) => row.commanderId)]);
  for (const link of state.campaign!.links)
    if (
      link.masterId === unit.ownerId &&
      state.generals[link.personId]?.userId === null &&
      state.generals[link.personId]?.cityKey === owner.cityKey
    )
      returning.add(link.personId);
  for (const id of returning) {
    const general = state.generals[id]!;
    general.cityKey = destination?.cityKey ?? 0;
    delete general.movePath;
    if (!destination) {
      general.nationId = null;
      general.officerLevel = 0;
    }
  }
  if (!destination)
    state.campaign!.links = state.campaign!.links.filter(
      (link) => !returning.has(link.personId) && !returning.has(link.masterId),
    );
  state.campaign!.units = state.campaign!.units.filter(
    (row) => !ids.has(row.id) && (destination || (!returning.has(row.ownerId) && !returning.has(row.commanderId))),
  );
  return false;
}

export function marchForce(units: readonly Readonly<CampaignUnitState>[]): CampaignUnitState {
  if (!units.length) throw new Error('행군할 병력이 없습니다.');
  const prior = units
    .filter((unit) => unit.supply)
    .sort((a, b) => a.supply!.remaining - b.supply!.remaining || a.id - b.id)[0]?.supply;
  return {
    ...units[0]!,
    troops: units.reduce((sum, unit) => sum + unit.troops, 0),
    ...(prior ? { supply: { ...prior } } : {}),
  };
}
