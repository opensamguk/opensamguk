import type { Prisma } from '@opensamguk/db';
import {
  APPOINTABLE_OFFICER_LEVELS,
  canManagePersonnel,
  courtAbilityRequirement,
  courtOfficeTitle,
  isLocalOffice,
  isOfficeResident,
  localOfficeTitle,
  localOfficeAbility,
  officerTitle,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { requireGeneral } from './queries';
import { nationTenureYears } from './nationTenure';

type Allowed = { ok: true } | { ok: false; reason: string };
type PersonnelMember = {
  generalId: number;
  name: string;
  officerLevel: number;
  title: string;
  isHuman: boolean;
  city: { cityKey: number; name: string };
  dedication: number;
  tenureYears?: number;
  officerCityKey?: number | null;
  resident?: boolean;
  eligibleLocalOffices?: number[];
};
export type PersonnelBoard = {
  actorId: number;
  topVictories?: { generalId: number; name: string; portraitId: number | null; wins: number }[];
  topStratagem?: { generalId: number; name: string; portraitId: number | null; successes: number }[];
  officeEffectsEnabled?: true;
  localOfficeMinimum?: number;
  officeCities?: { cityKey: number; name: string }[];
  appoint: Allowed;
  levels: {
    officerLevel: number;
    title: string;
    holderId: number | null;
    qualification?: string;
    eligibleIds?: number[];
  }[];
  members: PersonnelMember[];
};
function titleFor(level: number): string {
  const title = officerTitle(level);
  if (title === null) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '직책을 확인하지 못했습니다.' });
  return title;
}

// 호출자는 세션·계정·기능 사용 가능 여부를 검증하고 같은 스냅샷의 트랜잭션을 넘긴다.
// userId는 세션 사용자다. 요청의 국가·장수 ID를 권한 근거로 받지 않는다.
export async function readPersonnelBoard(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string; tick?: number },
  officeEffectsEnabled = false,
  courtRankEnabled = false,
  localOfficeMinimum?: number,
  courtAbilityEnabled = false,
): Promise<PersonnelBoard> {
  const actor = await requireGeneral(tx, input.worldId, input.userId);
  if (actor.nationId === null) throw new TRPCError({ code: 'FORBIDDEN', message: '국가에 소속되어야 합니다.' });
  const courtRank = courtRankEnabled
    ? (
        await tx.nation.findUniqueOrThrow({
          where: { worldId_id: { worldId: input.worldId, id: actor.nationId } },
          select: { level: true },
        })
      ).level
    : null;
  const courtTitle = (level: number) => (courtRank === null ? null : courtOfficeTitle(courtRank, level));
  const rows = await tx.general.findMany({
    where: { worldId: input.worldId, nationId: actor.nationId },
    orderBy: [{ officerLevel: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      officerLevel: true,
      userId: true,
      dedication: true,
      portraitId: true,
      removedAt: true,
      stratagemSuccesses: true,
      battleWins: true,
      ...(input.tick === undefined ? {} : { nationJoinedTick: true }),
      ...(localOfficeMinimum !== undefined || courtAbilityEnabled ? { strength: true, intel: true } : {}),
      ...(officeEffectsEnabled ? { officerCityKey: true } : {}),
      city: { select: { cityKey: true, name: true, ...(officeEffectsEnabled ? { nationId: true } : {}) } },
    },
  });
  const members = rows.map((row) => {
    const tenureYears =
      input.tick !== undefined && row.removedAt === null
        ? nationTenureYears(row.nationJoinedTick, input.tick)
        : undefined;
    return {
      generalId: row.id,
      name: row.name,
      officerLevel: row.officerLevel,
      title:
        officeEffectsEnabled && isLocalOffice(row.officerLevel)
          ? localOfficeTitle(row.officerLevel)
          : (courtTitle(row.officerLevel) ?? titleFor(row.officerLevel)),
      isHuman: row.userId !== null,
      city: { cityKey: row.city.cityKey, name: row.city.name },
      ...(officeEffectsEnabled
        ? {
            officerCityKey: row.officerCityKey ?? null,
            resident: isOfficeResident(
              { ...row, nationId: actor.nationId, cityKey: row.city.cityKey },
              row.city.nationId ?? null,
            ),
          }
        : {}),
      ...(localOfficeMinimum === undefined
        ? {}
        : {
            eligibleLocalOffices:
              row.removedAt === null
                ? ([2, 3, 4] as const).filter((level) => localOfficeAbility(row, level, localOfficeMinimum))
                : [],
          }),
      dedication: row.dedication,
      ...(tenureYears === undefined ? {} : { tenureYears }),
    };
  });
  const topVictories = rows
    .filter((row) => row.removedAt === null && row.battleWins > 0)
    .sort((a, b) => b.battleWins - a.battleWins || a.id - b.id)
    .slice(0, 5)
    .map(({ id, name, portraitId, battleWins }) => ({ generalId: id, name, portraitId, wins: battleWins }));
  const topStratagem = rows
    .filter((row) => row.removedAt === null && row.stratagemSuccesses > 0)
    .sort((a, b) => b.stratagemSuccesses - a.stratagemSuccesses || a.id - b.id)
    .slice(0, 7);
  return {
    actorId: actor.id,
    ...(topVictories.length ? { topVictories } : {}),
    ...(localOfficeMinimum === undefined ? {} : { localOfficeMinimum }),
    ...(topStratagem.length
      ? {
          topStratagem: topStratagem.map(({ id, name, portraitId, stratagemSuccesses }) => ({
            generalId: id,
            name,
            portraitId,
            successes: stratagemSuccesses,
          })),
        }
      : {}),
    ...(officeEffectsEnabled
      ? {
          officeEffectsEnabled: true as const,
          officeCities: await tx.city.findMany({
            where: {
              worldId: input.worldId,
              nationId: actor.nationId,
              OR: [{ kind: null }, { kind: { not: 'PASS' } }],
            },
            orderBy: { cityKey: 'asc' },
            select: { cityKey: true, name: true },
          }),
        }
      : {}),
    appoint: canManagePersonnel(actor.officerLevel)
      ? { ok: true }
      : { ok: false, reason: '군주만 임명·해임할 수 있습니다.' },
    levels: APPOINTABLE_OFFICER_LEVELS.flatMap((officerLevel) => {
      const holders = members.filter((member) => member.officerLevel === officerLevel);
      if (holders.length > 1)
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '직책에 장수가 둘 이상 있습니다.' });
      const title = courtTitle(officerLevel);
      if (courtRank !== null && title === null && holders.length === 0) return [];
      const required = courtAbilityRequirement(officerLevel);
      return [
        {
          officerLevel,
          title: title ?? titleFor(officerLevel),
          holderId: holders[0]?.generalId ?? null,
          ...(courtAbilityEnabled
            ? {
                qualification: required
                  ? `${required.stat === 'strength' ? '무력' : '지력'} ${required.minimum} 이상인 장수만 표시합니다.`
                  : '군주를 제외한 장수 중에서 임명할 수 있습니다.',
                eligibleIds: rows
                  .filter(
                    (row) =>
                      row.removedAt === null &&
                      row.officerLevel !== 12 &&
                      (!required || row[required.stat] >= required.minimum),
                  )
                  .map(({ id }) => id),
              }
            : {}),
        },
      ];
    }),
    members,
  };
}
