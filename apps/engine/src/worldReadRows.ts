import type { Prisma } from '@opensamguk/db';

export interface PersonnelReadRow {
  id: number;
  defaultPolicy: string | null;
  userId: string | null;
  lastActiveTick: number | null;
  validSlots: boolean;
}

export interface WorldReadRows {
  offices: Prisma.NationOfficeGetPayload<Record<string, never>>[];
  officeTurns: Prisma.NationOfficeTurnGetPayload<Record<string, never>>[];
  assignments: Prisma.AssignmentOfferGetPayload<Record<string, never>>[];
  trust: Prisma.NationTrustGetPayload<Record<string, never>>[];
  nationTurns: Prisma.NationTurnGetPayload<Record<string, never>>[];
  slotCount: number;
}

// World 잠금 아래 쓰기 전의 작은 원장을 함께 운반한다. 각 reader의 검사는 그대로 거친다.
export async function loadWorldReadRows(tx: Prisma.TransactionClient, worldId: string): Promise<WorldReadRows> {
  const [rows] = await tx.$queryRaw<WorldReadRows[]>`
    SELECT
      COALESCE((SELECT json_agg(o ORDER BY "nationId", "officerLevel")
        FROM "NationOffice" o WHERE "worldId" = ${worldId}), '[]'::json) AS offices,
      COALESCE((SELECT json_agg(t ORDER BY "nationId", "officerLevel", slot)
        FROM "NationOfficeTurn" t WHERE "worldId" = ${worldId}), '[]'::json) AS "officeTurns",
      COALESCE((SELECT json_agg(a ORDER BY "targetGeneralId", id)
        FROM "AssignmentOffer" a WHERE "worldId" = ${worldId} AND status = 'PENDING'), '[]'::json) AS assignments,
      COALESCE((SELECT json_agg(n ORDER BY "nationId")
        FROM "NationTrust" n WHERE "worldId" = ${worldId}), '[]'::json) AS trust,
      COALESCE((SELECT json_agg(t ORDER BY "nationId", slot)
        FROM "NationTurn" t WHERE "worldId" = ${worldId}), '[]'::json) AS "nationTurns",
      (SELECT count(*)::double precision FROM "GeneralTurn" WHERE "worldId" = ${worldId}) AS "slotCount"
  `;
  return rows!;
}
