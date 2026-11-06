import { toGameDate } from '../clock/clock';
import type { WorldView } from '../model/world';
import type { NpcCandidate } from '../npc';
import { frontier } from '../npc/frontier';

// 실행 가능 여부와 패·대기·권한은 기존 chooser가 같은 명령 check로 판정한다.
export function nationStrategyNpcCandidates(view: WorldView, nationId: number, tick: number): NpcCandidate[] {
  if (!view.ruleFeatures?.includes('nation-strategy-v1')) return [];
  const result: NpcCandidate[] = [];
  const year = toGameDate(view.startYear, tick).year;
  const strength: Record<number, number> = {};
  if (view.campaign) {
    for (const unit of view.campaign.units) {
      const owner = view.generals[unit.commanderId]?.nationId;
      if (owner != null) strength[owner] = (strength[owner] ?? 0) + unit.troops;
    }
  } else {
    for (const general of Object.values(view.generals)) {
      if (general.nationId !== null && general.removedAt === undefined && general.activeFromYear <= year)
        strength[general.nationId] = (strength[general.nationId] ?? 0) + general.crew;
    }
  }
  for (const city of Object.values(view.cities)) {
    if (
      city.nationId !== nationId ||
      (city.defence >= Math.round(city.defenceMax * 0.8) && city.wall >= Math.round(city.wallMax * 0.8))
    )
      continue;
    result.push({
      key: 'nation_mobilize',
      args: { cityKey: city.cityKey },
      score: frontier(view, nationId, city.cityKey) ? 130 : 60,
      reason: '수비가 부족한 자기 거점을 백성동원으로 보강한다.',
    });
  }
  for (const diplomacy of view.diplomacies) {
    if (diplomacy.nationA !== nationId && diplomacy.nationB !== nationId) continue;
    const target = diplomacy.nationA === nationId ? diplomacy.nationB : diplomacy.nationA;
    const ownStrength = strength[nationId] ?? 0,
      targetStrength = strength[target] ?? 0;
    if (diplomacy.state === 'WAR' && targetStrength > ownStrength * 1.5)
      result.push({
        key: 'nation_rivalry',
        args: { nationId: target },
        score: 140,
        reason: '병력이 우세한 교전국의 전쟁을 늦춰 재정비한다.',
      });
    if (diplomacy.state === 'DECLARED' && ownStrength > targetStrength && ownStrength > 0)
      result.push({
        key: 'nation_raid',
        args: { nationId: target },
        score: 110,
        reason: '병력이 우세할 때 선포 중인 국가와의 전쟁을 앞당긴다.',
      });
  }
  return result;
}
