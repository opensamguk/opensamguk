// 공성 장면 고르기 (docs/design/sam7-motif.md 공성전 두 번째 장면, 사용자 2026-11-15 "조각 구조로").
// 원본처럼 장면을 큰 성벽 조각과 덧붙이는 층으로 짜고, 성벽 재질은 흙벽, 벽돌, 돌 세 벌 중 하나를 쓴다.
// 원본이 도시마다 재질을 어떻게 고르는지는 확인하지 못해(미검증) 우리 규칙으로 정했다.

export type SiegeLayoutKey = 'corner' | 'bastion';
export type SiegeMaterial = 'earth' | 'brick' | 'stone';

export interface SiegeSite {
  key: number;
  kind: string;
  level: number | null;
}

/** 관은 산 사이를 막는 성벽이라 언제나 치성 장면, 도시는 거점 번호로 두 장면을 고르게 나눈다. */
export function siegeLayout(site: SiegeSite): SiegeLayoutKey {
  if (site.kind === 'PASS') return 'bastion';
  return site.key % 2 === 0 ? 'corner' : 'bastion';
}

/** 도읍급(7, 8등급)과 관은 돌, 6등급은 벽돌, 나머지는 다진 흙벽. */
export function siegeMaterial(site: SiegeSite): SiegeMaterial {
  if (site.kind === 'PASS') return 'stone';
  const level = site.level ?? 0;
  if (level >= 7) return 'stone';
  if (level === 6) return 'brick';
  return 'earth';
}

/** 방어도가 깎인 비율을 얼룩 0~6단계로 바꾼다. 0이면 얼룩을 붙이지 않는다. */
export function damageStage(defense: number, defenseMax: number): number {
  const lost = 1 - Math.max(0, defense) / Math.max(1, defenseMax);
  return Math.min(6, Math.max(0, Math.ceil(lost * 6 - 1e-9)));
}
