import type { Prisma } from '@opensamguk/db';
import {
  canExecuteNationCommand,
  decodeTreatyRecord,
  guideTreatyResponse,
  quoteTreatyProposal,
  toGameDate,
  TREATY_INPUTS,
  validateNationTrustState,
  type TreatyQuoteCode,
  type TreatyRelation,
  type TreatyResponseGuideCode,
  type TreatyState,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { recordsInput } from '../queries';
import { requireGeneral, requireWorld } from './queries';
import {
  checkTreatyRow,
  enabledTreatyKinds,
  requireTreatyBreakWorld,
  requireTreatyWorld,
  toTreatyDetail,
  treatyBreakEnabled,
  treatyTradeEnabled,
  type TreatyDetail,
} from './treatyQueries';
import { normalizeTreatyRequestPayload, type TreatyRequestKind } from './treatyRequests';

type GameDate = { year: number; month: number };
type NationRef = { id: number; name: string; color: string };
export type TrustRow = { nation: NationRef; brokenTreaties: number; lastBrokenAt: GameDate | null };
export type TreatyDenyCode = 'NO_PERMISSION' | 'WORLD_CLOSED' | 'IN_PROGRESS' | 'BAD_TARGET' | TreatyResponseGuideCode;
export type TreatyAllowed = { ok: true } | { ok: false; code: TreatyDenyCode; reason: string };
export type TreatyListItem = TreatyDetail & {
  from: NationRef | null;
  to: NationRef | null;
  proposedAt: GameDate;
  respondBy: GameDate | null;
  startAt: GameDate | null;
  endAt: GameDate | null;
  estimate: { mine: number; theirs: number } | null;
  canAccept: TreatyAllowed | null;
  canReject: TreatyAllowed | null;
  canBreak?: TreatyAllowed;
  brokenBy?: NationRef;
};
type TreatyTarget = { nation: NationRef; relation: TreatyRelation; relationEndAt: GameDate | null };
type PendingAction = {
  requestId: string | null;
  kind: TreatyRequestKind;
  treatyId: string | null;
  toNation: NationRef | null;
  accept: boolean | null;
  requestedBy: { name: string };
};
type RecentAction = {
  requestId: string;
  kind: TreatyRequestKind;
  treatyId: string | null;
  result: 'APPLIED' | 'REJECTED';
  outcome: 'PROPOSED' | 'ACCEPTED' | 'DECLINED' | 'BROKEN' | null;
  reason: string | null;
};
export type TreatyListPage = {
  breakEnabled?: true;
  canPropose: TreatyAllowed;
  targets: TreatyTarget[];
  items: TreatyListItem[];
  nextCursor: string | null;
  pending: PendingAction[];
  myRecent: RecentAction[];
};
export type TreatyQuote = {
  cost: { mine: number; theirs: number } | null;
  problem: { code: TreatyQuoteCode; reason: string } | null;
};

const kindSchema = z.enum(Object.keys(TREATY_INPUTS) as [TreatyRequestKind, ...TreatyRequestKind[]]);
const requestSchema = z.uuid();
function invalid(): never {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '조약 조회 결과를 확인하지 못했습니다.' });
}
function kindOf(kind: string): TreatyRequestKind {
  const result = kindSchema.safeParse(kind);
  if (!result.success) invalid();
  return result.data;
}
function requestIdOf(kind: TreatyRequestKind, key: string): string {
  const prefix = `${kind}:`;
  if (!key.startsWith(prefix)) invalid();
  const parsed = requestSchema.safeParse(key.slice(prefix.length));
  if (!parsed.success) invalid();
  return parsed.data;
}
function allowed(code: TreatyDenyCode, reason: string): TreatyAllowed {
  return { ok: false, code, reason };
}
function publicNation(nation: NationRef): NationRef {
  return { id: nation.id, name: nation.name, color: nation.color };
}
function quote(input: Parameters<typeof quoteTreatyProposal>[0], tradeEnabled = false) {
  try {
    return quoteTreatyProposal(input, { tradeEnabled });
  } catch {
    invalid();
  }
}
function responseGuide(input: Parameters<typeof guideTreatyResponse>[0], tradeEnabled = false) {
  try {
    return guideTreatyResponse(input, { tradeEnabled });
  } catch {
    invalid();
  }
}
async function recentActions(
  tx: Prisma.TransactionClient,
  world: Awaited<ReturnType<typeof requireWorld>>,
  userId: string,
): Promise<RecentAction[]> {
  const worldId = world.id;
  const events = await tx.inputEvent.findMany({
    where: {
      worldId,
      userId,
      kind: { in: enabledTreatyKinds(world) },
      status: { in: ['APPLIED', 'REJECTED'] },
    },
    orderBy: { sequence: 'desc' },
    take: 5,
  });
  return events.map((event) => {
    if (event.worldId !== worldId || event.userId !== userId) invalid();
    const kind = kindOf(event.kind);
    const requestId = requestIdOf(kind, event.idempotencyKey);
    let record: ReturnType<typeof decodeTreatyRecord>;
    try {
      record = decodeTreatyRecord(
        {
          sequence: event.sequence,
          generalId: event.generalId,
          kind,
          status: event.status,
          payload: event.payload,
          result: event.result,
        },
        { tradeEnabled: treatyTradeEnabled(world) },
      );
    } catch {
      invalid();
    }
    return {
      requestId,
      kind,
      treatyId:
        record.status === 'APPLIED'
          ? record.result.treatyId
          : 'treatyId' in record.payload
            ? record.payload.treatyId
            : null,
      result: record.status,
      outcome: record.status === 'APPLIED' ? record.result.outcome : null,
      reason: record.status === 'REJECTED' ? record.result.message : null,
    };
  });
}

// 세션의 userId를 받는다. 호출자는 인증 뒤 RepeatableRead 트랜잭션 하나를 넘긴다.
export async function listTreaties(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string; cursor: string | undefined },
): Promise<TreatyListPage> {
  const parsedCursor = recordsInput.shape.cursor.safeParse(input.cursor);
  if (!parsedCursor.success) throw new TRPCError({ code: 'BAD_REQUEST', message: '조약 목록 위치를 확인하세요.' });
  const world = await requireWorld(tx, input.worldId);
  requireTreatyWorld(world);
  const actor = await requireGeneral(tx, input.worldId, input.userId);
  const myRecent = await recentActions(tx, world, input.userId);
  const breakEnabled = treatyBreakEnabled(world);
  const noPermission = allowed('NO_PERMISSION', '조약을 처리할 권한이 없습니다.');
  const worldClosed = allowed('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  const permission = actor.nationId !== null && canExecuteNationCommand(actor.officerLevel, 'nation_pact');
  const canPropose: TreatyAllowed = !permission
    ? noPermission
    : world.status !== 'RUNNING'
      ? worldClosed
      : { ok: true };
  const nationId = actor.nationId;
  if (nationId === null)
    return {
      ...(breakEnabled ? { breakEnabled: true } : {}),
      canPropose,
      targets: [],
      items: [],
      nextCursor: null,
      pending: [],
      myRecent,
    };

  const nations = await tx.nation.findMany({
    where: { worldId: input.worldId },
    select: { id: true, name: true, color: true },
    orderBy: { id: 'asc' },
  });
  const refs = new Map(nations.map((n) => [n.id, publicNation(n)]));
  const diplomacies = await tx.diplomacy.findMany({
    where: { worldId: input.worldId, OR: [{ nationA: nationId }, { nationB: nationId }] },
    select: { nationA: true, nationB: true, state: true, untilTick: true },
  });
  const relations = new Map(diplomacies.map((d) => [d.nationA === nationId ? d.nationB : d.nationA, d]));
  const before = parsedCursor.data === undefined ? {} : { id: { lt: Number(parsedCursor.data) } };
  const outgoing = await tx.treaty.findMany({
    where: { worldId: input.worldId, fromNationId: nationId, ...before },
    orderBy: { id: 'desc' },
    take: 31,
  });
  const incoming = await tx.treaty.findMany({
    where: { worldId: input.worldId, toNationId: nationId, ...before },
    orderBy: { id: 'desc' },
    take: 31,
  });
  const page = [...outgoing, ...incoming].sort((a, b) => b.id - a.id).slice(0, 31);
  const checked = page.slice(0, 30).map((row) => checkTreatyRow(world, row));
  const brokenRows = checked.filter((row) => row.status === 'BROKEN');
  const brokenBy = new Map<number, NationRef>();
  if (brokenRows.length) {
    const events = await tx.inputEvent.findMany({
      where: { worldId: input.worldId, sequence: { in: brokenRows.map((row) => row.closedSequence) } },
    });
    const authors = new Map<number, number>();
    for (const row of brokenRows) {
      const matching = events.filter((event) => event.sequence === row.closedSequence);
      if (matching.length !== 1) invalid();
      const event = matching[0]!;
      let record: ReturnType<typeof decodeTreatyRecord>;
      try {
        record = decodeTreatyRecord(
          {
            sequence: event.sequence,
            generalId: event.generalId,
            kind: event.kind,
            status: event.status,
            payload: event.payload,
            result: event.result,
          },
          { tradeEnabled: treatyTradeEnabled(world) },
        );
      } catch {
        invalid();
      }
      if (
        record.kind !== 'treaty.break' ||
        record.status !== 'APPLIED' ||
        record.result.outcome !== 'BROKEN' ||
        record.result.treatyId !== String(row.id) ||
        ![row.fromNationId, row.toNationId].includes(record.result.brokenByNationId)
      )
        invalid();
      authors.set(row.id, record.result.brokenByNationId);
    }
    const missing = [...new Set(authors.values())].filter((id) => !refs.has(id));
    const removed = missing.length
      ? await tx.removedNation.findMany({
          where: { worldId: input.worldId, nationId: { in: missing } },
          select: { nationId: true, name: true, color: true },
        })
      : [];
    for (const [id, author] of authors) {
      const past = removed.find((row) => row.nationId === author);
      const nation = refs.get(author) ?? (past ? { id: past.nationId, name: past.name, color: past.color } : null);
      if (!nation) invalid();
      brokenBy.set(id, nation);
    }
  }
  const proposedNationIds = [
    ...new Set(checked.filter((row) => row.status === 'PROPOSED').flatMap((row) => [row.fromNationId, row.toNationId])),
  ];
  const counts =
    proposedNationIds.length === 0
      ? []
      : await tx.city.groupBy({
          by: ['nationId'],
          where: { worldId: input.worldId, nationId: { in: proposedNationIds } },
          _count: { _all: true },
        });
  const cityCounts = new Map(counts.map((row) => [row.nationId, row._count._all]));
  const generals = await tx.general.findMany({
    where: { worldId: input.worldId, nationId },
    select: { id: true, name: true, userId: true },
  });
  const names = new Map(generals.map((g) => [g.id, g.name]));
  const events = await tx.inputEvent.findMany({
    where: {
      worldId: input.worldId,
      status: 'PENDING',
      kind: { in: enabledTreatyKinds(world) },
      generalId: { in: generals.map((g) => g.id) },
    },
    orderBy: { id: 'asc' },
  });
  const pending: PendingAction[] = events.map((event) => {
    if (
      event.worldId !== input.worldId ||
      event.status !== 'PENDING' ||
      event.sequence !== null ||
      event.result !== null ||
      event.generalId === null ||
      !Number.isSafeInteger(event.generalId) ||
      event.generalId < 1 ||
      !names.has(event.generalId)
    )
      invalid();
    const kind = kindOf(event.kind),
      requestId = requestIdOf(kind, event.idempotencyKey);
    let payload: ReturnType<(typeof TREATY_INPUTS)[typeof kind]['payloadSchema']['parse']>;
    try {
      payload = TREATY_INPUTS[kind].payloadSchema.parse(event.payload);
    } catch {
      invalid();
    }
    return {
      requestId: event.userId === input.userId ? requestId : null,
      kind,
      treatyId: 'treatyId' in payload ? payload.treatyId : null,
      toNation: 'toNationId' in payload ? (refs.get(payload.toNationId) ?? null) : null,
      accept: 'accept' in payload && typeof payload.accept === 'boolean' ? payload.accept : null,
      requestedBy: { name: names.get(event.generalId)! },
    };
  });
  const responding = new Set(pending.filter((p) => p.kind === 'treaty.respond').map((p) => p.treatyId));
  const breaking = new Set(pending.filter((p) => p.kind === 'treaty.break').map((p) => p.treatyId));
  let ownGold: number | undefined;
  const items: TreatyListItem[] = [];
  for (const row of checked) {
    const detail = toTreatyDetail(row, nationId);
    if (detail === null) invalid();
    const from = refs.get(row.fromNationId) ?? null,
      to = refs.get(row.toNationId) ?? null;
    const current = relations.get(row.fromNationId === nationId ? row.toNationId : row.fromNationId)?.state ?? 'NONE';
    let estimate: TreatyListItem['estimate'] = null;
    if (row.status === 'PROPOSED' && from !== null && to !== null) {
      const result = quote(
        {
          fromNationId: row.fromNationId,
          toNationId: row.toNationId,
          clauses: row.clauses,
          fromCityCount: cityCounts.get(row.fromNationId) ?? 0,
          target: { relation: current, cityCount: cityCounts.get(row.toNationId) ?? 0 },
        },
        treatyTradeEnabled(world),
      );
      if (result.cost === null) invalid();
      estimate = detail.incoming
        ? { mine: result.cost.to, theirs: result.cost.from }
        : { mine: result.cost.from, theirs: result.cost.to };
    }
    let canAccept: TreatyAllowed | null = null,
      canReject: TreatyAllowed | null = null;
    if (detail.incoming && row.status === 'PROPOSED') {
      const gate = !permission
        ? noPermission
        : world.status !== 'RUNNING'
          ? worldClosed
          : responding.has(detail.id)
            ? allowed('IN_PROGRESS', '요청을 처리하는 중입니다.')
            : from === null || to === null
              ? allowed('BAD_TARGET', '조약 상대 국가가 없습니다.')
              : null;
      if (gate !== null) {
        canAccept = gate;
        canReject = gate;
      } else {
        if (ownGold === undefined) {
          const own = await tx.nation.findUnique({
            where: { worldId_id: { worldId: input.worldId, id: nationId } },
            select: { gold: true },
          });
          if (own === null) invalid();
          ownGold = own.gold;
        }
        const treaty: TreatyState = {
          id: row.id,
          fromNationId: row.fromNationId,
          toNationId: row.toNationId,
          clauses: row.clauses,
          status: 'PROPOSED',
          proposedTick: row.proposedTick,
          respondByTick: row.respondByTick,
          startTick: row.startTick,
          endTick: row.endTick,
        };
        const guidance = responseGuide(
          {
            treaty,
            tick: world.clockTick,
            relation: current,
            responderCityCount: cityCounts.get(row.toNationId) ?? 0,
            responderGold: ownGold,
          },
          treatyTradeEnabled(world),
        );
        canAccept = guidance.accept === null ? { ok: true } : allowed(guidance.accept.code, guidance.accept.message);
        canReject = guidance.reject === null ? { ok: true } : allowed(guidance.reject.code, guidance.reject.message);
      }
    }
    const date = (tick: number | null) => (tick === null ? null : toGameDate(world.startYear, tick));
    items.push({
      ...detail,
      from,
      to,
      proposedAt: toGameDate(world.startYear, row.proposedTick),
      respondBy: date(detail.respondByTick),
      startAt: date(row.startTick),
      endAt: date(row.endTick),
      estimate,
      canAccept,
      canReject,
      ...(breakEnabled && row.status === 'ACTIVE'
        ? {
            canBreak: !permission
              ? noPermission
              : world.status !== 'RUNNING'
                ? worldClosed
                : breaking.has(detail.id)
                  ? allowed('IN_PROGRESS', '요청을 처리하는 중입니다.')
                  : from === null || to === null
                    ? allowed('BAD_TARGET', '조약 상대 국가가 없습니다.')
                    : { ok: true as const },
          }
        : {}),
      ...(row.status === 'BROKEN' ? { brokenBy: brokenBy.get(row.id)! } : {}),
    });
  }
  const targets = nations
    .filter((n) => n.id !== nationId)
    .map((n) => {
      const d = relations.get(n.id);
      const current: TreatyRelation = d?.state ?? 'NONE';
      return {
        nation: publicNation(n),
        relation: current,
        relationEndAt:
          d?.state === 'DECLARED' || d?.state === 'NON_AGGRESSION' ? toGameDate(world.startYear, d.untilTick) : null,
      };
    });
  return {
    ...(breakEnabled ? { breakEnabled: true } : {}),
    canPropose,
    targets,
    items,
    nextCursor: page.length > 30 ? String(checked.at(-1)!.id) : null,
    pending,
    myRecent,
  };
}

export async function listTrust(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string },
): Promise<{ items: TrustRow[] }> {
  const world = await requireWorld(tx, input.worldId);
  requireTreatyBreakWorld(world);
  await requireGeneral(tx, input.worldId, input.userId);
  const [nations, removed, rows] = await Promise.all([
    tx.nation.findMany({ where: { worldId: input.worldId }, select: { id: true, name: true, color: true } }),
    tx.removedNation.findMany({
      where: { worldId: input.worldId },
      select: { nationId: true, name: true, color: true },
    }),
    tx.nationTrust.findMany({
      where: { worldId: input.worldId },
      orderBy: { nationId: 'asc' },
      select: { nationId: true, brokenTreaties: true, lastBrokenTick: true },
    }),
  ]);
  let trust: ReturnType<typeof validateNationTrustState>;
  try {
    trust = rows.length ? validateNationTrustState(rows) : [];
  } catch {
    invalid();
  }
  const current = new Map(nations.map((nation) => [nation.id, publicNation(nation)]));
  for (const row of trust) {
    if (current.has(row.nationId)) continue;
    const past = removed.find((nation) => nation.nationId === row.nationId);
    if (!past) invalid();
    current.set(past.nationId, { id: past.nationId, name: past.name, color: past.color });
  }
  const items = [...current.values()].map((nation): TrustRow => {
    const row = trust.find((entry) => entry.nationId === nation.id);
    return {
      nation,
      brokenTreaties: row?.brokenTreaties ?? 0,
      lastBrokenAt: row ? toGameDate(world.startYear, row.lastBrokenTick) : null,
    };
  });
  items.sort((a, b) => b.brokenTreaties - a.brokenTreaties || a.nation.id - b.nation.id);
  return { items };
}

// 세션의 userId로 권한부터 확인한다. 같은 RepeatableRead 안에서만 읽는다.
export async function quoteTreaty(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string; payload: unknown },
): Promise<TreatyQuote> {
  const world = await requireWorld(tx, input.worldId);
  requireTreatyWorld(world);
  const payload = normalizeTreatyRequestPayload('treaty.propose', input.payload);
  if (!('clauses' in payload)) invalid();
  if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  const actor = await requireGeneral(tx, input.worldId, input.userId);
  if (actor.nationId === null || !canExecuteNationCommand(actor.officerLevel, 'nation_pact'))
    throw new TRPCError({ code: 'FORBIDDEN', message: '조약을 처리할 권한이 없습니다.' });
  const target =
    payload.toNationId !== actor.nationId && payload.toNationId <= 2147483647
      ? await tx.nation.findUnique({
          where: { worldId_id: { worldId: input.worldId, id: payload.toNationId } },
          select: { id: true },
        })
      : null;
  let targetValue: { relation: TreatyRelation; cityCount: number } | null = null;
  let fromCityCount = 0;
  if (target !== null) {
    const relation = await tx.diplomacy.findUnique({
      where: {
        worldId_nationA_nationB: {
          worldId: input.worldId,
          nationA: Math.min(actor.nationId, payload.toNationId),
          nationB: Math.max(actor.nationId, payload.toNationId),
        },
      },
      select: { state: true },
    });
    fromCityCount = await tx.city.count({ where: { worldId: input.worldId, nationId: actor.nationId } });
    const cityCount = await tx.city.count({ where: { worldId: input.worldId, nationId: payload.toNationId } });
    targetValue = { relation: relation?.state ?? 'NONE', cityCount };
  }
  const result = quote(
    {
      fromNationId: actor.nationId,
      toNationId: payload.toNationId,
      clauses: payload.clauses,
      fromCityCount,
      target: targetValue,
    },
    treatyTradeEnabled(world),
  );
  return {
    cost: result.cost === null ? null : { mine: result.cost.from, theirs: result.cost.to },
    problem: result.problem === null ? null : { code: result.problem.code, reason: result.problem.message },
  };
}
