// core2026 c81d304, world/directory.ts and legacyProgress.ts. MIT (c) 2025 devsam.
const HONOR = [
  [640, '전무'],
  [2_560, '무명'],
  [5_760, '신동'],
  [10_240, '약간'],
  [16_000, '평범'],
  [23_040, '지역적'],
  [31_360, '전국적'],
  [40_960, '세계적'],
  [45_000, '유명'],
  [51_840, '명사'],
  [55_000, '호걸'],
  [64_000, '효웅'],
  [77_440, '영웅'],
] as const;

export function generalProgress(experience: number, dedication: number) {
  const level = Math.min(255, Math.floor(experience < 1_000 ? experience / 100 : Math.sqrt(experience / 10)));
  const levelFloor = level < 10 ? 100 * level : 10 * level ** 2;
  const nextLevelAt = level === 255 ? null : level < 10 ? 100 * (level + 1) : 10 * (level + 1) ** 2;
  const dedicationLevel = Math.min(30, Math.ceil(Math.sqrt(dedication) / 10));
  return {
    level,
    experienceInLevel: experience - levelFloor,
    experienceForNextLevel: nextLevelAt === null ? null : nextLevelAt - levelFloor,
    honorTitle: HONOR.find(([ceiling]) => experience < ceiling)?.[1] ?? '구세주',
    dedicationRank: dedicationLevel === 0 ? '무품관' : `${31 - dedicationLevel}품관`,
  };
}
