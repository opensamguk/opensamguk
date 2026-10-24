import type { Prisma } from '@opensamguk/db';
import {
  calculateOperationForecast,
  isInactive,
  isPastOperationTarget,
  isPolicyKey,
  isPolicyMode,
  nowTick,
  operationTargetTick,
  suggestOperationTurns,
  toGameDate,
  unitSetSchema,
  type Readiness,
  type WorldView,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import type { Context } from '../context';
import { nextTurnAt, readWorld, requireGeneral } from '../queries';
import { publicNationDisplaySelect } from '../visibility';
import { readView } from './queries';
import { displaySlots, readSlots } from './slots';

type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<typeof requireGeneral>>;
type OperationContext = Pick<Context, 'db' | 'now'> & { user: NonNullable<Context['user']> };
type ReadWorld = Parameters<Parameters<typeof readWorld>[2]>[1];
type OperationWorld = ReadWorld & {
  policyFromSequence: number | null;
  actionSequence: number;
  replayFormat: number;
  ruleFeatures: string[];
  unitSet: Prisma.JsonValue;
  tick: number;
};
type GameDate = ReturnType<typeof toGameDate>;
const include = {
  target: { select: { cityKey: true, name: true, nation: { select: publicNationDisplaySelect } } },
  createdBy: { select: { id: true, name: true } },
  members: { include: { general: { include: { city: { select: { name: true } } } } } },
} as const satisfies Prisma.OperationInclude;
type Operation = Prisma.OperationGetPayload<{ include: typeof include }>;

const denied = (code: string, reason: string) => ({ ok: false as const, code, reason });
const allowed = { ok: true as const };
const officer = (actor: Actor) => actor.nationId !== null && actor.officerLevel >= 5;
const sameNation = (actor: Actor) => {
  if (actor.nationId === null) throw new TRPCError({ code: 'FORBIDDEN', message: '국가에 소속되어야 합니다.' });
  return actor.nationId;
};
const canCreate = (actor: Actor) =>
  officer(actor) ? allowed : denied('NO_PERMISSION', '직책자만 작전을 만들 수 있습니다.');
const currentMembers = (operation: Operation) =>
  operation.members.filter((member) => member.general.nationId === operation.nationId);
const joined = (operation: Operation, actor: Actor) =>
  currentMembers(operation).some((member) => member.generalId === actor.id);
const canSuggest = (operation: Operation, actor: Actor) =>
  !joined(operation, actor)
    ? denied('NOT_PARTY', '참여 장수만 제안을 받을 수 있습니다.')
    : operation.status !== 'OPEN'
      ? denied('WRONG_STATUS', '닫힌 작전입니다.')
      : allowed;
const canClose = (operation: Operation, actor: Actor) =>
  operation.createdById !== actor.id && actor.officerLevel !== 12
    ? denied('NO_PERMISSION', '만든 장수나 군주만 작전을 닫을 수 있습니다.')
    : operation.status !== 'OPEN'
      ? denied('WRONG_STATUS', '닫힌 작전입니다.')
      : allowed;

export function operationTick(value: bigint): number {
  const tick = Number(value);
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('저장된 작전 목표 tick을 확인하세요.');
  return tick;
}

export function operationTargetAt(world: ReadWorld, tick: number): string | null {
  try {
    return nextTurnAt(world, tick);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

const compareDate = (left: GameDate, right: GameDate) => left.year - right.year || left.month - right.month;
const addMonths = (date: GameDate, count: number): GameDate => {
  const month = date.month - 1 + count;
  return { year: date.year + Math.floor(month / 12), month: (month % 12) + 1 };
};
export function operationMonths(current: GameDate, target: GameDate, lastCells: readonly GameDate[]): GameDate[] {
  if (lastCells.length === 0) return [];
  const last = lastCells.reduce((latest, date) => (compareDate(date, latest) > 0 ? date : latest));
  const end = [addMonths(target, 1), last, addMonths(current, 30)].reduce((first, date) =>
    compareDate(date, first) < 0 ? date : first,
  );
  const months: GameDate[] = [];
  for (let i = 0; i <= 30; i++) {
    const date = addMonths(current, i);
    if (compareDate(date, end) > 0) break;
    months.push(date);
  }
  return months;
}

export function operationIdle(
  general: { userId: string | null; lastActiveTick: number | null },
  tick: number,
  term: number,
) {
  return general.userId !== null && general.lastActiveTick !== null && isInactive(general.lastActiveTick, tick, term);
}

function clock(world: ReadWorld, now: number) {
  return nowTick({ ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null }, now);
}
async function readOperation<T>(
  ctx: OperationContext,
  worldId: string,
  read: (tx: Tx, world: OperationWorld, actor: Actor) => Promise<T>,
) {
  return readWorld(ctx.db, worldId, async (tx, world) => {
    const extra = await tx.world.findUniqueOrThrow({
      where: { id: worldId },
      select: { policyFromSequence: true, actionSequence: true, unitSet: true, replayFormat: true, ruleFeatures: true },
    });
    const actor = await requireGeneral(tx, worldId, ctx.user.id);
    return read(tx, { ...world, ...extra, tick: clock(world, ctx.now) }, actor);
  });
}
async function readRecord(tx: Tx, worldId: string, id: string, actor: Actor) {
  const nationId = sameNation(actor);
  const row = await tx.operation.findFirst({ where: { worldId, id, nationId }, include });
  if (!row) throw new TRPCError({ code: 'FORBIDDEN', message: '이 작전을 볼 수 없습니다.' });
  return row;
}
function forecastInput(
  world: OperationWorld,
  general: Actor,
  operation: Operation,
  turns: Awaited<ReturnType<typeof readSlots>>,
  view: WorldView,
) {
  const policyMode =
    world.replayFormat === 3
      ? world.ruleFeatures.includes('policy')
      : isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence });
  const policy = policyMode && general.userId !== null ? general.defaultPolicy : 'none';
  if (!isPolicyKey(policy)) throw new Error('저장된 기본 방침이 올바르지 않습니다.');
  return {
    startYear: world.startYear,
    nextTurnTick: general.nextTurnTick,
    deadlineTick: operationTick(operation.targetTick),
    targetCityKey: operation.targetCityKey,
    current: { crew: general.crew, train: general.train, atmos: general.atmos },
    min: { crew: operation.minCrew, train: operation.minTrain, atmos: operation.minAtmos },
    turns,
    view,
    generalId: general.id,
    policy,
    policyMode,
  };
}
async function timelines(tx: Tx, world: OperationWorld, operation: Operation, actor: Actor, view: WorldView) {
  const members = currentMembers(operation).sort(
    (a, b) => a.general.nextTurnTick - b.general.nextTurnTick || a.generalId - b.generalId,
  );
  return Promise.all(
    members.map(async ({ general }) => {
      const slots = await readSlots(tx, world.id, general.id);
      const forecast = calculateOperationForecast(forecastInput(world, general, operation, slots, view));
      const display = displaySlots(slots);
      const cells = forecast.cells.map(({ slot, tick, date }) => ({
        slot,
        tick,
        date,
        at: nextTurnAt(world, tick),
        turn: display[slot]!,
      }));
      return {
        generalId: general.id,
        name: general.name,
        cityKey: general.cityKey,
        cityName: general.city.name,
        isMe: general.id === actor.id,
        verdict: forecast.verdict,
        beyondWindow: forecast.beyondWindow,
        sortie: forecast.sortie === null ? null : cells[forecast.sortie.slot]!,
        expected: forecast.expected,
        cells,
      };
    }),
  );
}
function operationRow(
  world: OperationWorld,
  operation: Operation,
  actor: Actor,
  timeline: Awaited<ReturnType<typeof timelines>>,
) {
  const targetTick = operationTick(operation.targetTick);
  return {
    id: operation.id,
    target: { cityKey: operation.target.cityKey, cityName: operation.target.name, nation: operation.target.nation },
    targetDate: toGameDate(world.startYear, targetTick),
    targetTick,
    targetAt: operationTargetAt(world, targetTick),
    status: operation.status,
    createdBy: { generalId: operation.createdBy.id, name: operation.createdBy.name },
    members: timeline.length,
    ready: timeline.filter((member) => member.verdict === 'READY').length,
    joined: joined(operation, actor),
  };
}

export function listOperations(ctx: OperationContext, worldId: string) {
  return readOperation(ctx, worldId, async (tx, world, actor) => {
    const nationId = sameNation(actor);
    const rows = await tx.operation.findMany({
      where: { worldId, nationId, ...(officer(actor) ? {} : { members: { some: { generalId: actor.id } } }) },
      include,
      orderBy: [{ status: 'asc' }, { targetTick: 'asc' }, { id: 'asc' }],
    });
    const view = await readView(tx, worldId);
    return {
      canCreate: canCreate(actor),
      items: await Promise.all(
        rows.map(async (row) => operationRow(world, row, actor, await timelines(tx, world, row, actor, view))),
      ),
    };
  });
}
export function getOperation(ctx: OperationContext, input: { worldId: string; id: string }) {
  return readOperation(ctx, input.worldId, async (tx, world, actor) => {
    const operation = await readRecord(tx, input.worldId, input.id, actor);
    if (!officer(actor) && !joined(operation, actor))
      throw new TRPCError({ code: 'FORBIDDEN', message: '이 작전을 볼 수 없습니다.' });
    const timeline = await timelines(tx, world, operation, actor, await readView(tx, input.worldId));
    const { joined: _joined, ...row } = operationRow(world, operation, actor, timeline);
    void _joined;
    return {
      ...row,
      min: { crew: operation.minCrew, train: operation.minTrain, atmos: operation.minAtmos },
      timeline,
      months: operationMonths(
        toGameDate(world.startYear, world.tick),
        row.targetDate,
        timeline.map((member) => member.cells[29]!.date),
      ),
      canSuggest: canSuggest(operation, actor),
      canClose: canClose(operation, actor),
    };
  });
}
export function suggestOperation(ctx: OperationContext, input: { worldId: string; id: string }) {
  return readOperation(ctx, input.worldId, async (tx, world, actor) => {
    const operation = await readRecord(tx, input.worldId, input.id, actor);
    const permission = canSuggest(operation, actor);
    if (!permission.ok)
      throw new TRPCError({
        code: permission.code === 'NOT_PARTY' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
        message: permission.reason,
      });
    const turns = await readSlots(tx, input.worldId, actor.id);
    const result = suggestOperationTurns({
      ...forecastInput(world, actor, operation, turns, await readView(tx, input.worldId)),
      crewType: actor.crewType,
      actor: { generalId: actor.id, tick: world.tick, unitSet: unitSetSchema.parse(world.unitSet) },
    });
    return { ...result, revision: actor.turnRevision, current: displaySlots(turns), slots: displaySlots(result.slots) };
  });
}

async function writeWorld(tx: Tx, worldId: string, now: number): Promise<OperationWorld> {
  await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR SHARE`;
  const world = await tx.world.findUnique({ where: { id: worldId }, include: { result: true } });
  if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
  return { ...world, tick: clock(world, now) };
}
export interface CreateOperationInput {
  worldId: string;
  targetCityKey: number;
  targetYear: number;
  targetMonth: number;
  min: Readiness;
  memberIds: number[];
}
export function createOperation(ctx: OperationContext, input: CreateOperationInput) {
  return ctx.db.$transaction(async (tx) => {
    const world = await writeWorld(tx, input.worldId, ctx.now);
    const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
    if (!officer(actor)) throw new TRPCError({ code: 'FORBIDDEN', message: '직책자만 작전을 만들 수 있습니다.' });
    let targetTick: number;
    try {
      if (isPastOperationTarget(world.startYear, world.tick, input.targetYear, input.targetMonth)) throw new Error();
      targetTick = operationTargetTick(world.startYear, input.targetYear, input.targetMonth);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '작전 목표 연월을 확인하세요.' });
    }
    const target = await tx.city.findUnique({
      where: { worldId_cityKey: { worldId: input.worldId, cityKey: input.targetCityKey } },
      select: { cityKey: true },
    });
    if (!target) throw new TRPCError({ code: 'BAD_REQUEST', message: '목표 도시를 확인하세요.' });
    const members = await tx.general.findMany({
      where: { worldId: input.worldId, nationId: actor.nationId, id: { in: input.memberIds } },
      select: { id: true },
    });
    if (new Set(input.memberIds).size !== input.memberIds.length || members.length !== input.memberIds.length)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '참여 장수를 확인하세요.' });
    const operation = await tx.operation.create({
      data: {
        worldId: input.worldId,
        nationId: actor.nationId!,
        targetCityKey: input.targetCityKey,
        targetTick: BigInt(targetTick),
        createdById: actor.id,
        minCrew: input.min.crew,
        minTrain: input.min.train,
        minAtmos: input.min.atmos,
      },
      select: { id: true },
    });
    if (input.memberIds.length)
      await tx.operationMember.createMany({
        data: input.memberIds.map((generalId) => ({ worldId: input.worldId, operationId: operation.id, generalId })),
      });
    return operation;
  });
}
export function closeOperation(ctx: OperationContext, input: { worldId: string; id: string }) {
  return ctx.db.$transaction(async (tx) => {
    const world = await writeWorld(tx, input.worldId, ctx.now);
    const actor = await requireGeneral(tx, input.worldId, ctx.user.id);
    const operation = await readRecord(tx, input.worldId, input.id, actor);
    const permission = canClose(operation, actor);
    if (!permission.ok)
      throw new TRPCError({
        code: permission.code === 'WRONG_STATUS' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
        message: permission.reason,
      });
    const changed = await tx.operation.updateMany({
      where: { id: operation.id, worldId: input.worldId, status: 'OPEN' },
      data: { status: 'CLOSED' },
    });
    if (changed.count !== 1) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '닫힌 작전입니다.' });
    return operationRow(
      world,
      { ...operation, status: 'CLOSED' },
      actor,
      await timelines(tx, world, operation, actor, await readView(tx, input.worldId)),
    );
  });
}
export function inspectMembers(ctx: OperationContext, worldId: string) {
  return readOperation(ctx, worldId, async (tx, world, actor) => {
    if (!officer(actor)) throw new TRPCError({ code: 'FORBIDDEN', message: '직책자만 감찰할 수 있습니다.' });
    const rows = await tx.general.findMany({
      where: { worldId, nationId: actor.nationId },
      include: { city: { select: { name: true } } },
      orderBy: [{ officerLevel: 'desc' }, { id: 'asc' }],
    });
    return {
      items: await Promise.all(
        rows.map(async (general) => ({
          generalId: general.id,
          name: general.name,
          officerLevel: general.officerLevel,
          cityKey: general.cityKey,
          cityName: general.city.name,
          isHuman: general.userId !== null,
          crew: general.crew,
          train: general.train,
          atmos: general.atmos,
          turns: displaySlots(await readSlots(tx, worldId, general.id)).slice(0, 5),
          nextTurnAt: nextTurnAt(world, general.nextTurnTick),
          lastActiveAt: general.lastActiveAt?.toISOString() ?? null,
          idle: operationIdle(general, world.tick, world.turnTermMinutes),
        })),
      ),
    };
  });
}
