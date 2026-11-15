import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  canApproveProposal,
  proposalExpired,
  PROPOSAL_DEDICATION,
  PROPOSAL_EXPIRY_TICKS,
  PROPOSAL_OPEN_LIMIT,
  officerTitle,
  unitSetSchema,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireGeneral, requireWorld, readView } from './queries';
import { worldResolver } from './resolver';
import { requirePersonnelWorld } from './personnelAdmission';
import { readNationOfficeTabs, saveNationOfficeTurns } from './nationOfficeSlots';

type Tx = Prisma.TransactionClient;
type World = Awaited<ReturnType<typeof requireWorld>>;
type Actor = Awaited<ReturnType<typeof requireGeneral>>;
type Proposal = Prisma.CommandProposalGetPayload<Record<string, never>>;
function fail(
  code: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'PRECONDITION_FAILED',
  message: string,
): never {
  throw new TRPCError({ code, message });
}
export async function proposalContext(tx: Tx, worldId: string, userId: string, write = false) {
  const world = await requireWorld(tx, worldId, write);
  requirePersonnelWorld(world);
  const actor = await requireGeneral(tx, worldId, userId, write);
  if (actor.removedAt !== null || actor.nationId === null)
    fail('FORBIDDEN', '국가에 소속된 장수만 이용할 수 있습니다.');
  if (write && world.status === 'ENDED') fail('PRECONDITION_FAILED', '종료된 월드입니다.');
  return { world, actor };
}
function parseCommand(world: World, commandKey: string, args: unknown) {
  const def = worldResolver(world).resolver.get(commandKey);
  const parsed = def?.args.safeParse(args === undefined ? {} : args);
  if (!def || def.target !== 'nation' || !parsed?.success) fail('BAD_REQUEST', '국가 명령과 인자를 확인하세요.');
  return { def, args: parsed.data };
}
async function eligible(tx: Tx, world: World, nationId: number, key: string) {
  return (await tx.general.findMany({ where: { worldId: world.id, nationId, removedAt: null } })).filter((general) =>
    canApproveProposal(world, general.officerLevel, key),
  );
}
export async function listProposableCommands(tx: Tx, worldId: string, userId: string) {
  const { world, actor } = await proposalContext(tx, worldId, userId);
  const members = await tx.general.findMany({ where: { worldId, nationId: actor.nationId!, removedAt: null } });
  return worldResolver(world)
    .resolver.list('nation')
    .filter(
      (def) =>
        !canApproveProposal(world, actor.officerLevel, def.key) &&
        members.some((member) => canApproveProposal(world, member.officerLevel, def.key)),
    )
    .map((def) => ({
      key: def.key,
      name: def.name,
      category: def.category,
      argsSchema: z.toJSONSchema(def.args, { io: 'input' }),
    }));
}
export async function readProposalHistory(tx: Tx, worldId: string, userId: string) {
  const { actor } = await proposalContext(tx, worldId, userId);
  return tx.$queryRaw<{ tick: number; kind: 'proposal'; text: string }[]>`
    SELECT history."tick", 'proposal'::text AS kind, entry.value->>'text' AS text
    FROM "NationHistory" AS history
    CROSS JOIN LATERAL jsonb_array_elements(history.data->'proposals')
      WITH ORDINALITY AS entry(value, position)
    WHERE history."worldId" = ${worldId} AND history."nationId" = ${actor.nationId}
    ORDER BY history."tick" DESC, entry.position DESC
    LIMIT 30
  `;
}
export async function effectiveProposalStatus(tx: Tx, world: World, row: Proposal) {
  if (row.status !== 'PENDING') return row.status;
  const proposer = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: row.proposerId } } });
  const def = worldResolver(world).resolver.get(row.commandKey);
  return world.status === 'ENDED' ||
    proposalExpired(row, proposer ?? undefined, world.clockTick) ||
    !def ||
    def.target !== 'nation' ||
    !(await eligible(tx, world, row.nationId, row.commandKey)).length
    ? 'EXPIRED'
    : 'PENDING';
}
async function record(
  tx: Tx,
  world: World,
  actor: Actor,
  row: Proposal,
  action: 'create' | 'approve' | 'reject' | 'cancel',
  reason?: string,
) {
  const name = worldResolver(world).resolver.get(row.commandKey)?.name ?? row.commandKey;
  const verb = {
    create: '제안',
    approve: `승인 (제안자 공헌 +${PROPOSAL_DEDICATION})`,
    reject: '거절',
    cancel: '취소',
  }[action];
  await tx.inputEvent.create({
    data: {
      worldId: world.id,
      userId: actor.userId!,
      generalId: null,
      kind: 'proposal.record',
      idempotencyKey: `proposal:${randomUUID()}`,
      status: 'PENDING',
      payload: {
        proposalId: row.id,
        proposerId: row.proposerId,
        nationId: row.nationId,
        action,
        text: `${actor.name}: ${name} ${verb}${reason ? ` — ${reason}` : ''}`,
      },
    },
  });
}
export async function createProposal(
  tx: Tx,
  userId: string,
  input: { worldId: string; commandKey: string; args?: unknown; slot?: number | undefined; note?: string | undefined },
) {
  const { world, actor } = await proposalContext(tx, input.worldId, userId, true);
  const command = parseCommand(world, input.commandKey, input.args);
  if (canApproveProposal(world, actor.officerLevel, command.def.key))
    fail('FORBIDDEN', '직접 실행할 수 있는 명령은 제안할 수 없습니다.');
  if (!(await eligible(tx, world, actor.nationId!, command.def.key)).length)
    fail('BAD_REQUEST', '명령을 승인할 장수가 없습니다.');
  const rows = await tx.commandProposal.findMany({
    where: { worldId: world.id, nationId: actor.nationId!, status: 'PENDING' },
  });
  let opened = 0;
  for (const row of rows) {
    if ((await effectiveProposalStatus(tx, world, row)) !== 'PENDING') {
      await tx.commandProposal.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
      continue;
    }
    if (row.proposerId === actor.id) opened++;
    if (row.commandKey === command.def.key && isDeepStrictEqual(row.args, command.args))
      fail('CONFLICT', '같은 명령과 인자의 제안이 있습니다.');
  }
  if (opened >= PROPOSAL_OPEN_LIMIT) fail('CONFLICT', '열린 제안은 3건까지 가능합니다.');
  const row = await tx.commandProposal.create({
    data: {
      worldId: world.id,
      nationId: actor.nationId!,
      proposerId: actor.id,
      proposerLevel: actor.officerLevel,
      commandKey: command.def.key,
      args: command.args as Prisma.InputJsonValue,
      slot: input.slot ?? null,
      note: input.note ?? null,
      createdTick: world.clockTick,
      expiresTick: world.clockTick + PROPOSAL_EXPIRY_TICKS,
    },
  });
  await record(tx, world, actor, row, 'create', input.note);
  return { proposalId: row.id };
}
export async function listProposals(
  tx: Tx,
  userId: string,
  input: { worldId: string; box: 'received' | 'sent'; status?: string | undefined },
) {
  const { world, actor } = await proposalContext(tx, input.worldId, userId);
  const rows = await tx.commandProposal.findMany({
    where: { worldId: world.id, nationId: actor.nationId!, ...(input.box === 'sent' ? { proposerId: actor.id } : {}) },
    orderBy: [{ createdTick: 'desc' }, { id: 'asc' }],
  });
  let view: Awaited<ReturnType<typeof readView>> | null = null;
  const result = [];
  for (const row of rows) {
    if (input.box === 'received' && !canApproveProposal(world, actor.officerLevel, row.commandKey)) continue;
    const status = await effectiveProposalStatus(tx, world, row);
    if (input.status && status !== input.status) continue;
    if (input.box === 'received' && status === 'PENDING') view ??= await readView(tx, world.id);
    const proposer = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: row.proposerId } } });
    if (!proposer) continue;
    const def = worldResolver(world).resolver.get(row.commandKey);
    const failure =
      view && status === 'PENDING' && def
        ? def.precheck(
            view,
            {
              generalId: actor.id,
              target: 'nation',
              authority: 'office',
              tick: actor.nextTurnTick,
              unitSet: unitSetSchema.parse(world.unitSet),
            },
            row.args,
          )
        : undefined;
    result.push({
      id: row.id,
      proposer: {
        id: proposer.id,
        name: proposer.name,
        portraitId: proposer.portraitId,
        officerTitle: officerTitle(proposer.officerLevel),
      },
      commandKey: row.commandKey,
      commandName: def?.name ?? row.commandKey,
      args: row.args,
      argsSummary: JSON.stringify(row.args),
      slot: row.slot,
      note: row.note,
      status,
      createdTick: row.createdTick,
      expiresTick: row.expiresTick,
      precheck: view && status === 'PENDING' ? { ok: !failure, message: failure?.message ?? null } : null,
      response: row.responseBy === null ? null : { by: row.responseBy, at: row.responseTick, reason: row.reason },
    });
  }
  return result;
}
export async function respondProposal(
  tx: Tx,
  userId: string,
  input: {
    proposalId: string;
    decision: 'approve' | 'reject' | 'cancel';
    slot?: number | undefined;
    reason?: string | undefined;
  },
) {
  const found = await tx.commandProposal.findUnique({ where: { id: input.proposalId } });
  if (!found) fail('NOT_FOUND', '제안이 없습니다.');
  const { world, actor } = await proposalContext(tx, found.worldId, userId, true);
  // World 잠금 뒤 다시 읽어 두 승인자가 같은 제안을 처리하지 않게 한다.
  const row = await tx.commandProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
  if (row.nationId !== actor.nationId) fail('NOT_FOUND', '제안이 없습니다.');
  if (
    input.decision === 'cancel'
      ? row.proposerId !== actor.id
      : !canApproveProposal(world, actor.officerLevel, row.commandKey)
  )
    fail('FORBIDDEN', '이 제안을 처리할 권한이 없습니다.');
  if ((await effectiveProposalStatus(tx, world, row)) !== 'PENDING') fail('CONFLICT', '종료된 제안입니다.');
  const slot = input.slot ?? row.slot;
  if (input.decision === 'approve') {
    if (slot === null || slot === undefined) fail('BAD_REQUEST', '국가 예턴 칸을 선택하세요.');
    const turn = parseCommand(world, row.commandKey, row.args);
    const tabs = await readNationOfficeTabs(tx, world.id, userId);
    const tab = tabs.tabs.find((candidate) => candidate.officerLevel === actor.officerLevel)!;
    const saved = await saveNationOfficeTurns(
      tx,
      { worldId: world.id, userId, office: tab.office, revision: tab.revision, expectedActorId: actor.id },
      (old) => {
        old[slot] = { commandKey: turn.def.key, args: turn.args };
        return old;
      },
    );
    if (!saved.ok) fail('CONFLICT', '국가 예턴이 바뀌었습니다.');
  }
  const status = { approve: 'APPROVED', reject: 'REJECTED', cancel: 'CANCELLED' }[input.decision];
  await tx.commandProposal.update({
    where: { id: row.id },
    data: {
      status,
      responseBy: actor.id,
      responseTick: world.clockTick,
      reason: input.reason ?? null,
      ...(input.decision === 'approve' ? { slot } : {}),
    },
  });
  await record(tx, world, actor, row, input.decision, input.reason);
  return { ok: true as const, status };
}
