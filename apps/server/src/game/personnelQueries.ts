import type { Prisma } from '@opensamguk/db';
import { APPOINTABLE_OFFICER_LEVELS, canManagePersonnel, officerTitle } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { requireGeneral } from './queries';

type Allowed = { ok: true } | { ok: false; reason: string };
type PersonnelMember = {
  generalId: number;
  name: string;
  officerLevel: number;
  title: string;
  isHuman: boolean;
  city: { cityKey: number; name: string };
  dedication: number;
};
export type PersonnelBoard = {
  appoint: Allowed;
  levels: { officerLevel: number; title: string; holderId: number | null }[];
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
  input: { worldId: string; userId: string },
): Promise<PersonnelBoard> {
  const actor = await requireGeneral(tx, input.worldId, input.userId);
  if (actor.nationId === null) throw new TRPCError({ code: 'FORBIDDEN', message: '국가에 소속되어야 합니다.' });
  const rows = await tx.general.findMany({
    where: { worldId: input.worldId, nationId: actor.nationId },
    orderBy: [{ officerLevel: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      officerLevel: true,
      userId: true,
      dedication: true,
      city: { select: { cityKey: true, name: true } },
    },
  });
  const members = rows.map((row) => ({
    generalId: row.id,
    name: row.name,
    officerLevel: row.officerLevel,
    title: titleFor(row.officerLevel),
    isHuman: row.userId !== null,
    city: row.city,
    dedication: row.dedication,
  }));
  return {
    appoint: canManagePersonnel(actor.officerLevel)
      ? { ok: true }
      : { ok: false, reason: '군주만 임명·해임할 수 있습니다.' },
    levels: APPOINTABLE_OFFICER_LEVELS.map((officerLevel) => {
      const holders = members.filter((member) => member.officerLevel === officerLevel);
      if (holders.length > 1)
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '직책에 장수가 둘 이상 있습니다.' });
      return { officerLevel, title: titleFor(officerLevel), holderId: holders[0]?.generalId ?? null };
    }),
    members,
  };
}
