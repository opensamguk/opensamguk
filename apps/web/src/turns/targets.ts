// 인자 입력 화면의 대상 목록 계산 (INT-25). 서버 판정을 흉내 내지 않고 지도 자료로 거리와 묶음만 만든다.
// 대상이 맞는지는 서버의 사전 검사와 실행 때 판정한다.

export interface LinkedCity {
  key: number;
  links: readonly number[];
}

// 출발 도시에서 연결선을 따라 몇 칸인지 센다. 닿지 않는 도시는 지도에 없다.
export function cityDistances(cities: readonly LinkedCity[], from: number | null): Map<number, number> {
  const distance = new Map<number, number>();
  if (from === null || !cities.some((city) => city.key === from)) return distance;
  const byKey = new Map(cities.map((city) => [city.key, city]));
  distance.set(from, 0);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const next = (distance.get(current) ?? 0) + 1;
    for (const key of byKey.get(current)?.links ?? []) {
      if (distance.has(key) || !byKey.has(key)) continue;
      distance.set(key, next);
      queue.push(key);
    }
  }
  return distance;
}

export interface TargetCity {
  key: number;
  name: string;
  level: number;
  nationId: number | null;
}

export interface DistanceGroup<T> {
  // 0이면 출발 도시, null이면 연결선으로 닿지 않는 도시
  distance: number | null;
  items: T[];
}

// 후보 도시를 거리별로 묶는다. 같은 거리 안에서는 다른 국가 도시를 먼저, 그다음 규모가 큰 순, 이름순이다.
export function groupByDistance<T extends TargetCity>(
  candidates: readonly T[],
  distances: ReadonlyMap<number, number>,
  ownNationId: number | null,
): DistanceGroup<T>[] {
  const groups = new Map<number | null, T[]>();
  for (const city of candidates) {
    const distance = distances.get(city.key) ?? null;
    const list = groups.get(distance) ?? [];
    list.push(city);
    groups.set(distance, list);
  }
  const own = (city: T) => (ownNationId !== null && city.nationId === ownNationId ? 1 : 0);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([distance, items]) => ({
      distance,
      items: items.sort((a, b) => own(a) - own(b) || b.level - a.level || a.name.localeCompare(b.name, 'ko')),
    }));
}

// 장수 이름 표시 (D-083). 괄호와 그 안을 뺀다. 조조(曹操) → 조조, 유도(145년생) → 유도.
export function displayName(name: string): string {
  const stripped = name.replace(/\s*[（(][^()（）]*[)）]\s*/g, '').trim();
  return stripped === '' ? name : stripped;
}
