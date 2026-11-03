export const HERITAGE_V1 = {
  version: 1,
  perStat: 3,
  perGeneral: 6,
  perSeason: 5,
  activityMonths: [12, 24, 36],
  winPoints: 2,
} as const;

export const HERITAGE_ERRORS = {
  BAD_HERITAGE: '유산 배분을 확인하세요.',
  HERITAGE_INSUFFICIENT: '유산 포인트가 부족합니다.',
} as const;
