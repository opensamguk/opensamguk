import { randomUUID } from 'node:crypto';
import { nextActionSequence, type Prisma } from '@opensamguk/db';
import {
  APPOINTABLE_OFFICER_LEVELS,
  canUseNationTurns,
  canExecuteNationCommand,
  officerTitle,
  type QueuedTurn,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { requireGeneral, requireWorld } from './queries';
import { worldResolver } from './resolver';
import { requirePersonnelWorld } from './personnelAdmission';

export type OfficeIdentity = { nationId: number; officerLevel: number; tenure: number };
export const emptyOfficeTurn = (): QueuedTurn => ({ commandKey: 'nation_rest', args: {} });
type World = Awaited<ReturnType<typeof requireWorld>>;
type General = Awaited<ReturnType<typeof requireGeneral>>;

function requireOfficeActor(actor: General) {
  if (actor.nationId === null || !canUseNationTurns(actor.officerLevel))
    throw new TRPCError({ code: 'FORBIDDEN', message: '국가 예턴 권한이 없습니다.' });
  return actor.nationId;
}
function invalid(): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: '명령과 인자를 확인하세요.' });
}
export function parseOfficeTurn(
  world: World,
  level: number,
  input: { commandKey: string; args?: unknown } | null,
): QueuedTurn {
  if (input === null) return emptyOfficeTurn();
  const def = worldResolver(world).resolver.get(input.commandKey);
  const args = def?.args.safeParse(input.args === undefined ? {} : input.args);
  if (!def || def.target !== 'nation' || !canExecuteNationCommand(level, def.key) || !args?.success) invalid();
  return { commandKey: def.key, args: args.data };
}
function displayOfficeTurns(world: World, turns: readonly QueuedTurn[]) {
  const resolver = worldResolver(world).resolver;
  return turns.map(({ commandKey, args }) => ({
    commandKey,
    args,
    name: resolver.get(commandKey)?.name ?? commandKey,
  }));
}
async function readOfficeTurns(tx: Prisma.TransactionClient, world: World, nationId: number, officerLevel: number) {
  const rows = await tx.nationOfficeTurn.findMany({
    where: { worldId: world.id, nationId, officerLevel },
    orderBy: { slot: 'asc' },
  });
  const turns = Array.from({ length: 12 }, emptyOfficeTurn);
  const seen = new Set<number>();
  for (const row of rows) {
    if (!Number.isInteger(row.slot) || row.slot < 0 || row.slot > 11 || seen.has(row.slot))
      throw new Error('저장된 직책 칸이 잘못됐습니다.');
    seen.add(row.slot);
    turns[row.slot] = parseOfficeTurn(world, officerLevel, { commandKey: row.commandKey, args: row.args });
  }
  return turns;
}

export async function readNationOfficeTabs(tx: Prisma.TransactionClient, worldId: string, userId: string) {
  const world = await requireWorld(tx, worldId);
  requirePersonnelWorld(world);
  const actor = await requireGeneral(tx, worldId, userId);
  const nationId = requireOfficeActor(actor);
  const offices = await tx.nationOffice.findMany({ where: { worldId, nationId } });
  const holders = await tx.general.findMany({
    where: { worldId, nationId },
    select: { id: true, name: true, officerLevel: true },
  });
  const tabs = [];
  for (const officerLevel of [12, ...APPOINTABLE_OFFICER_LEVELS]) {
    const row = offices.find((office) => office.officerLevel === officerLevel);
    const occupied = holders.filter((general) => general.officerLevel === officerLevel);
    if (occupied.length > 1) throw new Error('한 직책에 장수가 둘 이상 있습니다.');
    const holder = occupied[0];
    tabs.push({
      office: { nationId, officerLevel, tenure: row?.tenure ?? 0 },
      officerLevel,
      title: officerTitle(officerLevel)!,
      holder: holder ? { generalId: holder.id, name: holder.name } : null,
      edit:
        actor.officerLevel === officerLevel
          ? { ok: true as const }
          : { ok: false as const, reason: '자기 직책 칸만 고칠 수 있습니다.' },
      revision: row?.turnRevision ?? 0,
      slots: displayOfficeTurns(world, await readOfficeTurns(tx, world, nationId, officerLevel)),
    });
  }
  return { tabs };
}

// caller의 동일 tx에서 World·장수·직책을 잠근 뒤 칸·기록·활동을 함께 저장한다.
export async function saveNationOfficeTurns(
  tx: Prisma.TransactionClient,
  input: { worldId: string; userId: string; office: OfficeIdentity; revision: number },
  change: (old: QueuedTurn[], world: World, officerLevel: number) => QueuedTurn[],
) {
  const world = await requireWorld(tx, input.worldId, true);
  requirePersonnelWorld(world);
  if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  const actor = await requireGeneral(tx, world.id, input.userId, true);
  const nationId = requireOfficeActor(actor);
  await tx.$queryRaw`SELECT "nationId" FROM "NationOffice" WHERE "worldId" = ${world.id} AND "nationId" = ${nationId} AND "officerLevel" = ${actor.officerLevel} FOR UPDATE`;
  const where = { worldId: world.id, nationId, officerLevel: actor.officerLevel };
  const row = await tx.nationOffice.findUnique({ where: { worldId_nationId_officerLevel: where } });
  if (
    input.office.nationId !== nationId ||
    input.office.officerLevel !== actor.officerLevel ||
    input.office.tenure !== (row?.tenure ?? 0)
  )
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '직책이 바뀌었습니다. 국가 예턴을 다시 불러오세요.' });
  const old = await readOfficeTurns(tx, world, nationId, actor.officerLevel);
  const current = row?.turnRevision ?? 0;
  if (current !== input.revision)
    return { ok: false as const, reason: 'STALE' as const, revision: current, slots: displayOfficeTurns(world, old) };
  if (current >= 2_147_483_647) throw new Error('직책 칸 revision 저장 범위를 넘었습니다.');
  const turns = change(old, world, actor.officerLevel).map((turn) => parseOfficeTurn(world, actor.officerLevel, turn));
  if (turns.length !== 12) invalid();
  const revision = current + 1;
  if (row) {
    const written = await tx.nationOffice.updateMany({
      where: { ...where, turnRevision: current, tenure: row.tenure },
      data: { turnRevision: revision },
    });
    if (written.count !== 1) throw new Error('직책 칸이 변경됐습니다.');
  } else await tx.nationOffice.create({ data: { ...where, turnRevision: revision, tenure: 0 } });
  await tx.nationOfficeTurn.deleteMany({ where });
  await tx.nationOfficeTurn.createMany({
    data: turns.map((turn, slot) => ({
      ...where,
      slot,
      commandKey: turn.commandKey,
      args: turn.args as Prisma.InputJsonValue,
    })),
  });
  const policy = world.ruleFeatures.includes('policy');
  const event = await tx.inputEvent.create({
    data: {
      worldId: world.id,
      userId: input.userId,
      generalId: actor.id,
      kind: 'nationTurns.set',
      idempotencyKey: `nationTurns.set:${randomUUID()}`,
      status: 'APPLIED',
      sequence: await nextActionSequence(tx, world.id),
      tick: world.clockTick,
      payload: { office: input.office, revision: current, turns } as unknown as Prisma.InputJsonValue,
      result: { revision, ...(policy ? { activeTick: world.clockTick } : {}) },
    },
  });
  if (policy)
    await tx.general.update({
      where: { worldId_id: { worldId: world.id, id: actor.id } },
      data: { lastActiveTick: Math.max(actor.lastActiveTick ?? 0, world.clockTick), lastActiveAt: event.createdAt },
    });
  return { ok: true as const, revision, slots: displayOfficeTurns(world, turns) };
}
