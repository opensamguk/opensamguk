// core2026 domestic investment's gold-cost scale is simplified for MVP.
// This is a new balance table; source resources: resources/NOTICE.md.
export const BALANCE = {
  DEVEL_COST: 100, MAX_TECH: 12_000, MAX_TRUST: 100,
  REST_HEAL: 1, FRONT_FACTOR: 0.5,
  // core2026 che_정착장려·che_주민선정의 인구/민심 단위. resources/NOTICE.md.
  SETTLE_EFFECT_FACTOR: 10, GOODWILL_EFFECT_FACTOR: 0.1,
  SETTLE_COST_FACTOR: 2, GOODWILL_COST_FACTOR: 2,
} as const;
