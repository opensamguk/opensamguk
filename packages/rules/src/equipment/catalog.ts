import { EQUIPMENT_STATS, equipmentConfigSchema } from './config';

// core2026 df6c926 일반 장비(devsam MIT). 출처는 resources/NOTICE.md, 실물 비용은 D-070이다.
const groups = [
  { slot: 'horse', names: ['노기', '조랑', '노새', '나귀', '갈색마', '흑색마'] },
  { slot: 'weapon', names: ['단도', '단궁', '단극', '목검', '죽창', '소부'] },
  { slot: 'book', names: ['효경전', '회남자', '변도론', '건상역주', '여씨춘추', '사민월령'] },
] as const;
const costs = [1000, 3000, 6000, 10000, 15000, 21000] as const;

export const STANDARD_EQUIPMENT_CONFIG = equipmentConfigSchema.parse({
  version: 1,
  items: groups.flatMap(({ slot, names }) =>
    names.map((name, index) => {
      const grade = index + 1;
      return {
        key: `${slot}_0${grade}`,
        name,
        slot,
        grade,
        cost: costs[index]!,
        requiredSecurity: grade * 1000,
        stat: EQUIPMENT_STATS[slot],
        bonus: grade,
        goods: { iron: slot === 'weapon' ? grade * 5 : 0, wood: 0, horses: slot === 'horse' ? grade * 5 : 0 },
      };
    }),
  ),
  sellRateBp: 5000,
  tradeExperience: 10,
});
