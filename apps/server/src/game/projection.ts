import type { InitialGeneral } from '@opensamguk/rules';
// 명시한 공개 필드만 반환한다. DB·입력 기록을 그대로 직렬화하지 않는다.
export function ownGeneral(
  g: Omit<InitialGeneral, 'politics' | 'charm'> & { politics?: number | null; charm?: number | null },
) {
  return {
    id: g.id,
    name: g.name,
    portraitId: g.portraitId,
    nationId: g.nationId,
    cityKey: g.cityKey,
    leadership: g.leadership,
    strength: g.strength,
    intel: g.intel,
    ...(g.politics != null && g.charm != null ? { politics: g.politics, charm: g.charm } : {}),
    officerLevel: g.officerLevel,
    birthYear: g.birthYear,
    deathYear: g.deathYear,
    activeFromYear: g.activeFromYear,
    personality: g.personality,
    special: g.special,
    gold: g.gold,
    rice: g.rice,
    crew: g.crew,
    crewType: g.crewType,
    train: g.train,
    atmos: g.atmos,
    experience: g.experience,
    dedication: g.dedication,
    age: g.age,
    injury: g.injury,
    nextTurnTick: g.nextTurnTick,
  };
}
