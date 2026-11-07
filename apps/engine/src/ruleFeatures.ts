import type { Prisma } from '@opensamguk/db';
import {
  assertSlotSet,
  emptyQueue,
  isPolicyKey,
  activityPayloadSchema,
  applyPersonnelInputStep,
  completePersonnelStep,
  setPolicyPayloadSchema,
  updateResidenceAnchors,
  recordedLineageSuccession,
  reputationInputEvents,
  RELATIONS_FEATURE,
  recordedPossession,
  type PersonnelMonthResult,
  type PersonnelStepPacket,
  type ReplayState,
  type WorldState,
  type NationLifecycleEffects,
} from '@opensamguk/rules';
import type { EngineFeature, QueuedInputHandler } from './features';
import { loadReplayState } from './monthly';
import { loadWorld } from './worldLoader';
import { loadOfficeState, persistOfficeState } from './personnelState';
import { loadAssignmentState, persistAssignmentState } from './assignmentState';
import { appendNationHistory } from './commandPersistence';
import { persistEffects } from './persist';
import { loadNationTrust, loadTreaties, persistTreatyClosures } from './treatyState';
import { processTreatyQueuedInput } from './treatyInput';
import { loadResidenceAnchors, persistResidenceAnchors } from './residenceState';
import { persistForeignCampaignInput, processCampaignQueuedInput } from './campaignInput';
import { processCityResourceInput } from './cityResourceInput';
import { processLogisticsInput } from './logistics/input';
import { processGovernanceInput } from './governance/input';
import { PgGovernanceRepository, appendGovernanceMovements } from './governance/repository';
import { reconcileGovernanceOrder } from './governance/service';
import { appendLogisticsMovements } from './logisticsState';
import { logisticsMovementSchema, governanceMovementSchema } from '@opensamguk/rules';
import { z } from 'zod';
import { processLineageInput } from './lineage/input';
import { PgLineageRepository, persistLineageMonth } from './lineage/repository';
import { reconcileLineageOrder } from './lineage/service';
import type { LineageMonthEffects } from '@opensamguk/rules';
import { processStratagemCardsInput } from './stratagemCards/input';
import { reconcileQueuedStratagemCards } from './stratagemCards/state';
import { appendReputationEvents, loadReputationLedger, persistMonthlyReview } from './reputationState';
import { persistNationLifecycleMonth } from './nationLifecycleState';

export async function loadPersonnelTurnContext(tx: Prisma.TransactionClient, worldId: string, state: WorldState) {
  if (state.ruleFeatures?.includes('policy')) {
    const expectedSlots = emptyQueue().map((_, slot) => slot);
    // 조인 계획이 바뀌어도 이 조회의 예턴 집계는 한 번만 계산한다.
    const rows = await tx.$queryRaw<
      {
        id: number;
        defaultPolicy: string | null;
        userId: string | null;
        lastActiveTick: number | null;
        slots: number[] | null;
      }[]
    >`
      WITH turn_slots AS MATERIALIZED (
        SELECT "generalId", array_agg(slot ORDER BY slot) AS slots
        FROM "GeneralTurn" WHERE "worldId" = ${worldId}
        GROUP BY "generalId"
      )
      SELECT g.id, g."defaultPolicy", g."userId", g."lastActiveTick",
        CASE WHEN t.slots = ${expectedSlots}::integer[] THEN NULL
          ELSE COALESCE(t.slots, ARRAY[]::integer[]) END AS slots
      FROM "General" g
      LEFT JOIN turn_slots t ON t."generalId" = g.id
      WHERE g."worldId" = ${worldId}
      ORDER BY g.id
    `;
    // NULL은 정본 칸 배열과의 동등 검사를 마친 행이다.
    for (const row of rows) if (row.slots !== null) assertSlotSet(row.slots.map((slot) => ({ slot })));
    for (const row of rows) {
      if (!isPolicyKey(row.defaultPolicy)) throw new Error('저장된 기본 방침이 올바르지 않습니다.');
      if (row.userId !== null && row.lastActiveTick === null) throw new Error('사람 장수의 활동 tick이 없습니다.');
    }
  }
  const { offices } = await loadOfficeState(tx, worldId);
  const residenceAnchors = await loadResidenceAnchors(tx, worldId);
  return { state, offices, residenceAnchors };
}

export async function persistPersonnelPacket(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: Pick<ReplayState, 'residenceAnchors'>,
  packet: PersonnelStepPacket,
  anchors: Record<number, number>,
  at: { tick: number; sequence: number },
): Promise<void> {
  const { tick, sequence } = at;
  await persistOfficeState(tx, worldId, packet.office.before, packet.office.next);
  await persistAssignmentState(tx, worldId, packet.assignment);
  if (packet.logs.length) {
    const last = await tx.generalLog.findFirst({
      where: { worldId, sequence },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });
    // 개인 턴 본문은 0번을 쓰고, 먼저 저장한 가계 기록 뒤에 인사 기록을 잇는다.
    let ordinal = Math.max(1, (last?.ordinal ?? 0) + 1);
    for (const log of packet.logs)
      await tx.generalLog.create({ data: { ...log, worldId, tick, sequence, ordinal: ordinal++ } });
  }
  await persistResidenceAnchors(tx, worldId, before.residenceAnchors!, anchors);
}

const processPolicyInput: QueuedInputHandler = async (tx, world, event, { tick }) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status === 'ENDED') return reject('WORLD_CLOSED', '종료된 월드입니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId } });
  if (!user || user.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${event.generalId} FOR UPDATE`;
  const general = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: event.generalId } } });
  if (!general || general.userId !== event.userId) return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const parsed = (event.kind === 'general.setPolicy' ? setPolicyPayloadSchema : activityPayloadSchema).safeParse(
    event.payload,
  );
  if (!parsed.success) return reject('BAD_POLICY', '활동·기본 방침 입력이 올바르지 않습니다.');
  const policy = event.kind === 'general.setPolicy' ? setPolicyPayloadSchema.parse(event.payload).policy : null;
  await tx.general.update({
    where: { worldId_id: { worldId: world.id, id: general.id } },
    data: {
      ...(policy ? { defaultPolicy: policy } : {}),
      lastActiveTick: Math.max(general.lastActiveTick ?? 0, tick),
      lastActiveAt: event.createdAt,
    },
  });
  return { status: 'APPLIED', result: { ...(policy ? { policy } : {}), activeTick: tick } };
};

const processPersonnelInput: QueuedInputHandler = async (tx, world, event, { tick, sequence }) => {
  const before = await loadReplayState(tx, world.id);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId } });
  if (event.generalId === null) throw new Error('인사 입력의 장수가 없습니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${event.generalId} FOR UPDATE`;
  const kind = event.kind;
  if (kind !== 'personnel.appoint' && kind !== 'personnel.dismiss' && kind !== 'offer.respond')
    throw new Error('인사 입력 종류를 확인하세요.');
  const outcome = applyPersonnelInputStep(
    before.state,
    before.offices!,
    {
      kind,
      generalId: event.generalId,
      userId: event.userId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    },
    { tick, worldStatus: world.status, userActive: user?.status === 'ACTIVE' },
  );
  if (outcome.status === 'REJECTED') return outcome;
  const anchors = updateResidenceAnchors({
    before: before.state,
    after: outcome.packet.state,
    anchors: before.residenceAnchors!,
    tick,
    createdHumanId: null,
  });
  await persistEffects(tx, world.id, outcome.packet.state, [{ kind: 'world', state: outcome.packet.state }], {
    tick,
    sequence,
  });
  await persistPersonnelPacket(tx, world.id, before, outcome.packet, anchors, { tick, sequence });
  return { status: 'APPLIED', result: outcome.result as unknown as Prisma.InputJsonValue };
};

export const builtInEngineFeatures: readonly EngineFeature[] = [
  { key: 'nation-strategy-v1' },
  { key: 'prepared-turns-v1' },
  { key: 'nation-research-v1' },
  { key: RELATIONS_FEATURE },
  { key: 'city-scale-v1' },
  {
    key: 'stratagem-cards-v1',
    queuedInputs: { 'stratagem-cards.act': processStratagemCardsInput },
    // 다른 후처리의 엄격한 적재 전에 소유를 맞춘다. 원생성 월 시각으로 멱등 정리한다.
    afterQueuedInput: (tx, world) => reconcileQueuedStratagemCards(tx, world.id),
  },
  {
    key: 'logistics-v1',
    queuedInputs: { 'logistics.order': processLogisticsInput },
    async persistMonthly(tx, worldId, _before, _next, effects, context) {
      const rows = z.strictObject({ movements: z.array(logisticsMovementSchema) }).parse(effects).movements;
      await appendLogisticsMovements(tx, worldId, rows, context);
    },
  },
  { key: 'campaign-assignment-v2' },
  {
    key: 'campaign-v1',
    queuedInputs: {
      'campaign.relationship': processCampaignQueuedInput,
      'campaign.unit': processCampaignQueuedInput,
      'campaign.order': processCampaignQueuedInput,
    },
    afterQueuedInput: (tx, world, before, input) =>
      ['city.resources', 'logistics.order', 'governance.act', 'lineage.act', 'stratagem-cards.act'].includes(input.kind)
        ? Promise.resolve()
        : persistForeignCampaignInput(tx, world, before, input),
  },
  {
    key: 'governance-v1',
    queuedInputs: { 'governance.act': processGovernanceInput },
    afterQueuedInput: (tx, world, _before, input) =>
      reconcileGovernanceOrder(new PgGovernanceRepository(tx), world.id, {
        tick: input.tick!,
        sequence: input.sequence,
      }),
    async persistMonthly(tx, worldId, _before, _next, effects, context) {
      const rows = z.object({ movements: z.array(governanceMovementSchema) }).parse(effects).movements;
      await appendGovernanceMovements(tx, worldId, rows, context);
    },
  },
  { key: 'city-resources-v1', queuedInputs: { 'city.resources': processCityResourceInput } },
  { key: 'five-stats' },
  { key: 'battle-affinity-v2' },
  { key: 'intel-v1' },
  { key: 'equipment-v1' },
  { key: 'operational-map' },
  { key: 'stratagem-basic' },
  { key: 'policy', queuedInputs: { 'general.setPolicy': processPolicyInput, 'general.active': processPolicyInput } },
  {
    key: 'heritage-v1',
  },
  {
    key: 'lineage-v1',
    queuedInputs: { 'lineage.act': processLineageInput },
    afterQueuedInput: (tx, world, _before, input) =>
      reconcileLineageOrder(new PgLineageRepository(tx), world.id, { tick: input.tick!, sequence: input.sequence }),
    persistMonthly: (tx, worldId, before, next, effects, context) =>
      persistLineageMonth(tx, worldId, before, next, effects as LineageMonthEffects, context),
  },
  {
    key: 'nation-lifecycle-v1',
    async afterQueuedInput(tx, world) {
      await loadWorld(tx, world.id);
    },
    persistMonthly: (tx, worldId, _before, _next, effects, at) =>
      persistNationLifecycleMonth(tx, worldId, effects as NationLifecycleEffects, at),
  },
  {
    key: 'personnel',
    async loadWorld(tx, worldId, state) {
      const office = await loadOfficeState(tx, worldId);
      return {
        ...state,
        ...(office.officeTurns ? { officeTurns: office.officeTurns } : {}),
        ...(await loadAssignmentState(tx, worldId)),
      };
    },
    async loadReplayState(tx, worldId, replay) {
      const { offices } = await loadOfficeState(tx, worldId);
      const residenceAnchors = await loadResidenceAnchors(tx, worldId);
      return { ...replay, offices, residenceAnchors };
    },
    queuedInputs: {
      'personnel.appoint': processPersonnelInput,
      'personnel.dismiss': processPersonnelInput,
      'offer.respond': processPersonnelInput,
    },
    async afterQueuedInput(tx, world, before, input) {
      const state = await loadWorld(tx, world.id);
      const packet = completePersonnelStep(
        before.state,
        before.offices!,
        { state, offices: before.offices!, closedOffers: [], logs: [] },
        input.tick!,
      );
      const anchors = updateResidenceAnchors({
        before: before.state,
        after: packet.state,
        anchors: before.residenceAnchors!,
        tick: input.tick!,
        createdHumanId: input.kind === 'general.create' ? input.generalId : null,
        succession: recordedLineageSuccession(input),
        possession: recordedPossession(input),
      });
      await persistEffects(tx, world.id, packet.state, [{ kind: 'world', state: packet.state }], {
        tick: input.tick!,
        sequence: input.sequence,
      });
      await persistPersonnelPacket(tx, world.id, before, packet, anchors, {
        tick: input.tick!,
        sequence: input.sequence,
      });
    },
    async persistMonthly(tx, worldId, before, next, effects, { tick, sequence }) {
      const result = effects as PersonnelMonthResult;
      await persistPersonnelPacket(tx, worldId, before, result.packet, next.residenceAnchors!, { tick, sequence });
      for (const entry of result.history) await appendNationHistory(tx, worldId, tick, entry.nationId, entry.text);
    },
  },
  {
    key: 'treaty',
    loadWorld: async (tx, worldId, state) => ({
      ...state,
      ...(await loadTreaties(tx, worldId, { tradeEnabled: state.ruleFeatures?.includes('treaty-trade') ?? false })),
    }),
    queuedInputs: {
      'treaty.propose': (tx, world, event, context) =>
        processTreatyQueuedInput(tx, world, event, {
          ...context,
          treatyTradeEnabled: world.ruleFeatures.includes('treaty-trade'),
        }),
      'treaty.respond': (tx, world, event, context) =>
        processTreatyQueuedInput(tx, world, event, {
          ...context,
          treatyTradeEnabled: world.ruleFeatures.includes('treaty-trade'),
        }),
    },
    async persistMonthly(tx, worldId, before, next, _effects, context) {
      await persistTreatyClosures(tx, worldId, before.state, next.state, context);
    },
  },
  {
    key: 'treaty-break',
    loadWorld: async (tx, worldId, state) => ({ ...state, ...(await loadNationTrust(tx, worldId)) }),
    queuedInputs: {
      'treaty.break': (tx, world, event, context) =>
        processTreatyQueuedInput(tx, world, event, {
          ...context,
          treatyBreakEnabled: true,
          treatyTradeEnabled: world.ruleFeatures.includes('treaty-trade'),
        }),
    },
  },
  { key: 'treaty-trade' },
  {
    key: 'reputation-v1',
    async loadReplayState(tx, worldId, replay) {
      return { ...replay, reputation: await loadReputationLedger(tx, worldId, replay.state.startYear) };
    },
    async afterQueuedInput(tx, world, before, input) {
      await appendReputationEvents(tx, world.id, reputationInputEvents({ before: before.state, input }));
    },
    persistMonthly: (tx, worldId, _before, next, effects, { tick }) =>
      persistMonthlyReview(tx, worldId, next, effects, tick),
  },
];
