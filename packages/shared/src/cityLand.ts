export type CityGrade = '경' | '특' | '대' | '중' | '소' | '현';
export const CITY_LAND: Readonly<Record<CityGrade, { core: number; ring: number; fill: number }>> = {
  경: { core: 4, ring: 4, fill: 0.96 },
  특: { core: 3, ring: 4, fill: 0.9 },
  대: { core: 3, ring: 3, fill: 0.84 },
  중: { core: 2, ring: 3, fill: 0.78 },
  소: { core: 2, ring: 2, fill: 0.72 },
  현: { core: 1, ring: 1, fill: 0.6 },
};
export const OPEN_LAND = 5;
export function cityGrade(kind: string | null | undefined, level = 5): CityGrade | null {
  if (kind === 'FIELD') return null;
  if (kind === 'PASS' || kind === 'PORT') return '현';
  return level >= 9 ? '경' : level === 8 ? '특' : level === 7 ? '대' : level === 6 ? '중' : level === 5 ? '소' : '현';
}
// 좌표는 화면과 동일하며 짝수 한 변에는 반 정수 좌표를 쓴다.
export function cityLandSlots(kind: string | null | undefined, level: number) {
  const grade = cityGrade(kind, level);
  const core = grade ? CITY_LAND[grade].core : 0;
  const size = grade ? core + 2 * CITY_LAND[grade].ring : OPEN_LAND;
  const slots: { id: string; zone: 'inside' | 'outside'; i: number; j: number }[] = [];
  for (let i = -(size - 1) / 2; i <= (size - 1) / 2; i++)
    for (let j = -(size - 1) / 2; j <= (size - 1) / 2; j++) {
      const zone = core && Math.abs(i) <= (core - 1) / 2 && Math.abs(j) <= (core - 1) / 2 ? 'inside' : 'outside';
      slots.push({ id: `${i},${j}`, zone, i, j });
    }
  return slots;
}
