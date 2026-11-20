// 이동과 출병의 목적지 후보와 경로 (D-103). 서버 조회(commands.moveTargets, attackTargets)가 생기기 전에
// 같은 규칙으로 화면에서 미리 계산한다. 실행 판정은 언제나 서버 사전 검사가 한다.
import type { SchematicCity } from './SchematicMap';

export interface TargetPath {
  path: number[];
  turns: number;
  /** 출병이 지나며 휩쓸 부속 현 */
  swept: number[];
}

const COUNTY = 2;
const MAJOR = 5;

/** 경로 칸 수에서 걸리는 턴. 서버 기본값 제안과 같게 칸 2개당 1턴, 올림이다. */
export const turnsForPath = (path: readonly number[]) => Math.max(1, Math.ceil((path.length - 1) / 2));

function bfs(
  byKey: ReadonlyMap<number, SchematicCity>,
  start: number,
  passable: (city: SchematicCity) => boolean,
): Map<number, number[]> {
  const paths = new Map<number, number[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const city = byKey.get(key);
    if (!city) continue;
    for (const next of [...city.links].sort((a, b) => a - b)) {
      if (paths.has(next)) continue;
      const target = byKey.get(next);
      if (!target || !passable(target)) continue;
      paths.set(next, [...paths.get(key)!, next]);
      queue.push(next);
    }
  }
  return paths;
}

export function moveTargets(
  cities: readonly SchematicCity[],
  here: number | null,
  ownNationId: number | null,
): Map<number, TargetPath> {
  const out = new Map<number, TargetPath>();
  const byKey = new Map(cities.map((city) => [city.key, city]));
  const start = here === null ? undefined : byKey.get(here);
  if (!start) return out;
  // 우리 땅 안은 길로 이어진 어디든 간다.
  if (ownNationId !== null)
    for (const [key, path] of bfs(byKey, start.key, (city) => city.nationId === ownNationId))
      if (key !== start.key) out.set(key, { path, turns: turnsForPath(path), swept: [] });
  // 우리 땅 밖은 바로 붙은 곳만 간다.
  for (const next of start.links) {
    const target = byKey.get(next);
    if (!target || out.has(next)) continue;
    if (target.nationId === ownNationId && ownNationId !== null) continue;
    out.set(next, { path: [start.key, next], turns: 1, swept: [] });
  }
  return out;
}

export function attackTargets(
  cities: readonly SchematicCity[],
  here: number | null,
  ownNationId: number | null,
): Map<number, TargetPath> {
  const out = new Map<number, TargetPath>();
  const byKey = new Map(cities.map((city) => [city.key, city]));
  const start = here === null ? undefined : byKey.get(here);
  if (!start) return out;
  const enemy = (city: SchematicCity) => city.nationId !== ownNationId;
  for (const next of start.links) {
    const target = byKey.get(next);
    if (target && enemy(target)) out.set(next, { path: [start.key, next], turns: 1, swept: [] });
  }
  // 큰 도시는 그 나라 부속 현만 지나서 닿으면 바로 친다. 현의 수비 여부는 서버가 판정한다.
  for (const firstKey of start.links) {
    const first = byKey.get(firstKey);
    if (!first || first.level !== COUNTY || !enemy(first) || first.nationId === null) continue;
    const owner = first.nationId;
    const paths = bfs(
      byKey,
      first.key,
      (city) => city.nationId === owner && (city.level === COUNTY || city.level >= MAJOR),
    );
    for (const [key, tail] of paths) {
      const target = byKey.get(key)!;
      if (target.level < MAJOR || out.has(key)) continue;
      const inner = tail.slice(0, -1);
      if (!inner.every((step) => byKey.get(step)?.level === COUNTY)) continue;
      const path = [start.key, ...tail];
      out.set(key, { path, turns: turnsForPath(path), swept: inner });
    }
  }
  return out;
}
