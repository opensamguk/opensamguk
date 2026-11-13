import type { Prisma } from '@opensamguk/db';
import { publicNationPower, type WorldState } from '@opensamguk/rules';

export async function persistRanking(
  tx: Prisma.TransactionClient,
  worldId: string,
  state: WorldState,
  seed: string,
  at: { tick: number; year: number; month: number },
) {
  const counters = await tx.general.findMany({
    where: { worldId },
    select: { id: true, battleWins: true, captures: true, stratagemSuccesses: true },
  });
  const byId = new Map(counters.map((general) => [general.id, general]));
  const battles = await tx.generalBattleStats.findMany({ where: { worldId } });
  const battlesById = new Map(battles.map((row) => [row.generalId, row]));
  const active = Object.values(state.generals).filter(
    (general) => general.removedAt === undefined && general.activeFromYear <= at.year,
  );
  const nationInfo = (id: number | null) => {
    const nation = id === null ? undefined : state.nations[id];
    return nation ? { id: nation.id, name: nation.name, color: nation.color } : null;
  };
  const generals = active
    .sort((a, b) => a.id - b.id)
    .map((general) => ({
      id: general.id,
      name: general.name,
      nation: nationInfo(general.nationId),
      dedication: general.dedication,
      experience: general.experience,
      wins: byId.get(general.id)!.battleWins,
      captures: byId.get(general.id)!.captures,
      stratagemSuccesses: byId.get(general.id)!.stratagemSuccesses,
      battleStats: (() => {
        const battle = battlesById.get(general.id);
        return battle
          ? {
              engagements: battle.engagements,
              winRate: battle.wins / battle.engagements,
              kills: Number(battle.kills),
              killRate: Number(battle.kills) / Math.max(1, Number(battle.casualties)),
              ...(battle.humanEngagements > 0
                ? {
                    humanKills: Number(battle.humanKills),
                    humanKillRate: Number(battle.humanKills) / Math.max(1, Number(battle.humanCasualties)),
                  }
                : {}),
            }
          : null;
      })(),
    }));
  const nations = Object.values(state.nations)
    .sort((a, b) => a.id - b.id)
    .map((nation) => {
      const cities = Object.values(state.cities).filter((city) => city.nationId === nation.id).length;
      const count = active.filter((general) => general.nationId === nation.id).length;
      return {
        id: nation.id,
        name: nation.name,
        color: nation.color,
        philosophy: nation.philosophy,
        cities,
        generals: count,
        power: publicNationPower(state, nation.id, { seed, tick: at.tick, year: at.year }),
      };
    });
  const data = { ...at, generals, nations };
  await tx.rankingSnapshot.upsert({ where: { worldId }, create: { worldId, ...data }, update: data });
  return nations;
}
