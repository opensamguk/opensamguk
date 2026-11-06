// 단위 시험 전용 병종표 (T4-86). 수치는 이 시험에서 새로 정했고 resources/unitset/*.json을 옮겨 적지 않았다.
// *.test.ts(x)만 import한다. 화면 묶음에 들어가지 않는다 (id t486-fixture가 dist에 없어야 한다).
// 1300의 tech 조건은 모집 조건이 있어도 선택지에서 빠지지 않는지 보려고 둔다.
const unit = (id: number, armType: number, name: string, attack: number, defence: number) => ({
  id,
  armType,
  name,
  attack,
  defence,
  speed: 7,
  avoid: 10,
  magicCoef: 0,
  cost: 10,
  rice: 10,
  attackCoef: {},
  defenceCoef: {},
});

export const TEST_UNIT_SET = {
  id: 't486-fixture',
  name: '시험 병종표',
  defaultCrewTypeId: 1100,
  armTypes: { '0': '성벽', '1': '보', '2': '궁', '3': '기' },
  crewTypes: [
    { ...unit(1000, 0, '시험 성벽', 90, 90), requirements: [{ kind: 'impossible' as const }] },
    unit(1100, 1, '시험 보병', 110, 140),
    unit(1200, 2, '시험 궁병', 120, 100),
    { ...unit(1300, 3, '시험 기병', 160, 110), requirements: [{ kind: 'tech' as const, min: 3000 }] },
  ],
};
