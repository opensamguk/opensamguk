import type { Prisma } from '@opensamguk/db';
import {
  activityPayloadSchema,
  applyPersonnelInputStep,
  completePersonnelStep,
  setPolicyPayloadSchema,
  updateResidenceAnchors,
  type PersonnelMonthResult,
  type PersonnelStepPacket,
  type ReplayState,
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

export async function persistPersonnelPacket(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: ReplayState,
  packet: PersonnelStepPacket,
  anchors: Record<number, number>,
  tick: number,
): Promise<void> {
  await persistOfficeState(tx, worldId, packet.office.before, packet.office.next);
  await persistAssignmentState(tx, worldId, packet.assignment);
  for (const log of packet.logs) await tx.generalLog.create({ data: { ...log, worldId, tick } });
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
  await persistPersonnelPacket(tx, world.id, before, outcome.packet, anchors, tick);
  return { status: 'APPLIED', result: outcome.result as unknown as Prisma.InputJsonValue };
};

export const builtInEngineFeatures: readonly EngineFeature[] = [
  {
    key: 'campaign-v1',
    queuedInputs: { 'campaign.relationship': processCampaignQueuedInput, 'campaign.unit': processCampaignQueuedInput },
    afterQueuedInput: persistForeignCampaignInput,
  },
  { key: 'five-stats' },
  { key: 'operational-map' },
  { key: 'stratagem-basic' },
  { key: 'policy', queuedInputs: { 'general.setPolicy': processPolicyInput, 'general.active': processPolicyInput } },
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
      });
      await persistEffects(tx, world.id, packet.state, [{ kind: 'world', state: packet.state }], {
        tick: input.tick!,
        sequence: input.sequence,
      });
      await persistPersonnelPacket(tx, world.id, before, packet, anchors, input.tick!);
    },
    async persistMonthly(tx, worldId, before, next, effects, { tick }) {
      const result = effects as PersonnelMonthResult;
      await persistPersonnelPacket(tx, worldId, before, result.packet, next.residenceAnchors!, tick);
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
];
