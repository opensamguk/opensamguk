// T4-12 U-11의 공개 정책. 저장 병력은 조회할 때 이 구간으로 바꾼다.
const crewBandFloors = [0, 1, 1_000, 5_000, 10_000, 20_000, 50_000] as const;

export interface IntelDisclosurePolicy {
  crew(crew: number): { min: number; max: number | null };
  withinAge(ageMonths: number): boolean;
}

export const intelPolicy: IntelDisclosurePolicy = {
  crew(crew) {
    if (!Number.isSafeInteger(crew) || crew < 0) throw new Error('첩보 병력 값을 확인하세요.');
    for (let i = crewBandFloors.length - 1; i >= 0; i--) {
      const min = crewBandFloors[i]!;
      if (crew < min) continue;
      const next = crewBandFloors[i + 1];
      return { min, max: next === undefined ? null : next - 1 };
    }
    throw new Error('첩보 병력 값을 확인하세요.');
  },
  withinAge: () => true,
};
