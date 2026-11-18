// 길 그물(INT-27, 사용자 2026-11-14: "길을 굽기 전에 먼저 길을 어떻게 구성할지", "성의있게. 현대식으로 만들지 말고").
// 칸 경로(tileRoutes)를 길마다 따로 그리면 같은 칸을 지나는 길이 끝에서 엇갈리고, 같은 성에서 비슷한 방향으로 나가는 두
// 길이 나란히 가다 갈라져 작은 삼각형이 생겼다. 그래서 칸 사이 연결을 하나의 그물로 모아 갈림점·거점 사이 토막으로
// 나누고 토막마다 한 번만 그린다. 토막 끝은 성의 성문(그림 바닥 마름모 네 변 한가운데)에, 관문은 길이 지나는 방향의 문에
// 붙인다. 옛길처럼 조금 굽이치게 한다. 순수 계산만 둔다.

export type Point = { x: number; y: number };
/** 관문 그림 방향: a 기본(문이 왼쪽 아래↔오른쪽 위), b 좌우 뒤집기(왼쪽 위↔오른쪽 아래), h 가로 성벽(위↔아래), v 세로 성벽(왼쪽↔오른쪽). */
export type PassOrient = 'a' | 'b' | 'h' | 'v';
export type RoadSite = {
  id: string;
  kind: 'CITY' | 'PASS' | 'PORT' | 'FIELD';
  /** 거점 그림 바닥 마름모의 화면 가운데(캔버스 좌표). */
  centre: Point;
  /** 바닥 마름모 가로(캔버스 단위). 세로는 그 절반이다. */
  width: number;
  /** 쓸 수 있는 관문 그림 방향(없으면 대각선 둘). */
  passOrients?: readonly PassOrient[];
};
export type RoadSegment = { points: Point[]; major: boolean };

const unit = (x: number, y: number) => {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};
/** 관문 방향별 문 두 곳(바닥 마름모 가운데 기준 오프셋, 가로 w). */
export function passGates(orient: PassOrient, w: number): Point[] {
  if (orient === 'a')
    return [
      { x: w / 4, y: -w / 8 },
      { x: -w / 4, y: w / 8 },
    ];
  if (orient === 'b')
    return [
      { x: w / 4, y: w / 8 },
      { x: -w / 4, y: -w / 8 },
    ];
  if (orient === 'h')
    return [
      { x: 0, y: -w / 4 },
      { x: 0, y: w / 4 },
    ];
  return [
    { x: -w / 2, y: 0 },
    { x: w / 2, y: 0 },
  ];
}
/** 성의 네 성문(바닥 마름모 네 변 한가운데). */
export function cityGates(w: number): Point[] {
  return [
    { x: w / 4, y: -w / 8 },
    { x: w / 4, y: w / 8 },
    { x: -w / 4, y: w / 8 },
    { x: -w / 4, y: -w / 8 },
  ];
}

/** 관문에 닿는 길 방향들(가운데 → 바깥)로 문이 가장 잘 맞는 그림 방향을 고른다. */
export function choosePassOrient(directions: readonly Point[], allowed: readonly PassOrient[]): PassOrient {
  let best: PassOrient = allowed[0] ?? 'a';
  let bestScore = -Infinity;
  for (const orient of allowed) {
    const gates = passGates(orient, 1).map((gate) => unit(gate.x, gate.y));
    const score = directions.reduce((sum, d) => {
      const dir = unit(d.x, d.y);
      return sum + Math.max(...gates.map((gate) => gate.x * dir.x + gate.y * dir.y));
    }, 0);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = orient;
    }
  }
  return best;
}

/**
 * 칸 경로들을 그물로 모아 토막으로 나눈다.
 * - paths: 길마다 칸 번호 목록과 대로 여부.
 * - centre: 칸 번호 → 칸 가운데(캔버스 좌표).
 * - siteAt: 칸 번호 → 그 칸의 거점(없으면 undefined).
 */
export function buildRoadNetwork(
  paths: ReadonlyArray<{ tiles: readonly number[]; major: boolean }>,
  centre: (tile: number) => Point,
  siteAt: (tile: number) => RoadSite | undefined,
  meander = 0.9,
): { segments: RoadSegment[]; passOrient: Map<string, PassOrient> } {
  const edgeMajor = new Map<string, boolean>();
  const neighbours = new Map<number, Set<number>>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (const { tiles, major } of paths)
    for (let i = 1; i < tiles.length; i++) {
      const a = tiles[i - 1]!;
      const b = tiles[i]!;
      if (a === b) continue;
      const k = key(a, b);
      edgeMajor.set(k, (edgeMajor.get(k) ?? false) || major);
      (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
      (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
    }
  const isNode = (tile: number) => siteAt(tile) !== undefined || (neighbours.get(tile)?.size ?? 0) !== 2;
  const used = new Set<string>();
  const chains: Array<{ tiles: number[]; major: boolean }> = [];
  for (const [start, next] of neighbours) {
    if (!isNode(start)) continue;
    for (const first of next) {
      if (used.has(key(start, first))) continue;
      const tiles = [start, first];
      let major = edgeMajor.get(key(start, first)) ?? false;
      used.add(key(start, first));
      let previous = start;
      let current = first;
      while (!isNode(current)) {
        const forward = [...neighbours.get(current)!].find((tile) => tile !== previous)!;
        used.add(key(current, forward));
        major ||= edgeMajor.get(key(current, forward)) ?? false;
        tiles.push(forward);
        previous = current;
        current = forward;
      }
      chains.push({ tiles, major });
    }
  }
  // 관문 방향: 관문 칸에서 나가는 토막들의 방향.
  const passOrient = new Map<string, PassOrient>();
  const leaving = new Map<string, Point[]>();
  for (const { tiles } of chains)
    for (const [end, inner] of [
      [tiles[0]!, tiles[1]!],
      [tiles[tiles.length - 1]!, tiles[tiles.length - 2]!],
    ] as const) {
      const site = siteAt(end);
      if (site?.kind !== 'PASS') continue;
      const a = centre(end);
      const b = centre(inner);
      (leaving.get(site.id) ?? leaving.set(site.id, []).get(site.id)!).push({ x: b.x - a.x, y: b.y - a.y });
    }
  for (const [id, directions] of leaving) {
    const tile = [...neighbours.keys()].find((t) => siteAt(t)?.id === id);
    const site = tile === undefined ? undefined : siteAt(tile);
    passOrient.set(id, choosePassOrient(directions, site?.passOrients ?? ['a', 'b']));
  }
  // 토막 끝을 성문·관문 문에 붙이고 곡선으로 다듬는다.
  const segments: RoadSegment[] = [];
  for (const { tiles, major } of chains) {
    const points = tiles.map(centre);
    for (const end of [0, points.length - 1]) {
      const site = siteAt(tiles[end]!);
      if (!site) continue;
      const inner = points[end === 0 ? 1 : points.length - 2]!;
      const dir = unit(inner.x - site.centre.x, inner.y - site.centre.y);
      const gates =
        site.kind === 'PASS' ? passGates(passOrient.get(site.id) ?? 'a', site.width) : cityGates(site.width);
      let gate = gates[0]!;
      let best = -Infinity;
      for (const candidate of gates) {
        const g = unit(candidate.x, candidate.y);
        const score = g.x * dir.x + g.y * dir.y;
        if (score > best) {
          best = score;
          gate = candidate;
        }
      }
      const out = unit(gate.x, gate.y);
      const door = { x: site.centre.x + gate.x, y: site.centre.y + gate.y };
      const stub = { x: door.x + out.x * site.width * 0.14, y: door.y + out.y * site.width * 0.14 };
      if (end === 0) points.splice(0, 1, door, stub);
      else points.splice(points.length - 1, 1, stub, door);
    }
    segments.push({ points: wander(chaikin(points), meander, tiles[0]! * 7919 + tiles[tiles.length - 1]!), major });
  }
  return { segments, passOrient };
}

/** 양 끝을 두고 모서리를 두 번 깎아 부드럽게 한다. */
export function chaikin(points: readonly Point[], passes = 2): Point[] {
  let line = points.slice();
  for (let pass = 0; pass < passes && line.length > 2; pass++) {
    const next = [line[0]!];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    next.push(line[line.length - 1]!);
    line = next;
  }
  return line;
}

/** 옛길 굽이: 진행 방향에 수직으로 천천히 흔든다. 양 끝(성문)에서는 흔들지 않는다. */
export function wander(points: readonly Point[], amplitude: number, seed: number): Point[] {
  if (points.length < 3 || amplitude <= 0) return points.slice();
  const lengths = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const total = lengths[lengths.length - 1]!;
  const phase = (seed % 997) * 0.37;
  return points.map((point, i) => {
    if (i === 0 || i === points.length - 1) return point;
    const a = points[i - 1]!;
    const b = points[i + 1]!;
    const n = unit(-(b.y - a.y), b.x - a.x);
    const s = lengths[i]!;
    const taper = Math.min(1, s / 4, (total - s) / 4);
    const offset = amplitude * taper * (Math.sin(s * 0.55 + phase) * 0.6 + Math.sin(s * 0.21 + phase * 1.7) * 0.4);
    return { x: point.x + n.x * offset, y: point.y + n.y * offset };
  });
}
