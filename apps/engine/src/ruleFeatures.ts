import type { Prisma } from '@opensamguk/db';
import {
  assertSlotSet,
  CITY_SEASONAL_EVENTS_FEATURE,
  DEFENSE_STANCE_FEATURE,
  INACTIVE_REMOVAL_FEATURE,
  GENERAL_PERSONALITY_FEATURE,
  COMBAT_SPECIALTY_FEATURE,
  BATTLE_TACTICS_FEATURE,
  TROOP_FEATURE,
  TROOP_ACTION_KIND,
  HERITAGE_BENEFIT_KIND,
  HERITAGE_BENEFITS_FEATURE,
  DOMESTIC_SPECIALTY_FEATURE,
  GENERAL_PROFICIENCY_FEATURE,
  NPC_NATION_POLICY_FEATURE,
  NATION_FINANCE_FEATURE,
  NATION_FINANCE_KIND,
  RANKED_PAYROLL_FEATURE,
  WALL_INCOME_FEATURE,
  WAR_INCOME_FEATURE,
  CITY_CONFLICT_FEATURE,
  STAT_GROWTH_FEATURE,
  financeRatesInput,
  NATION_RESTRICTIONS_FEATURE,
  NATION_RESTRICTIONS_KIND,
  NATION_RESTRICTIONS_MIN_OFFICE,
  changeNationRestrictions,
  nationRestrictions,
  nationRestrictionsInput,
  storedNationRestrictions,
  NPC_NATION_POLICY_KIND,
  npcNationPolicyInput,
  BALANCE,
  DEFENSE_STANCE_KIND,
  defenseStanceInput,
  COURT_PROMOTION_FEATURE,
  DIPLOMATIC_COOLDOWN_FEATURE,
  NATION_PHILOSOPHY_FEATURE,
  PLAYER_AUTOPLAY_FEATURE,
  RESEARCH_ERA_FEATURE,
  isPolicyKey,
  activityPayloadSchema,
  applyPersonnelInputStep,
  completePersonnelStep,
  treatyOptions,
  EXPANDED_TREATY_FEATURE,
  setPolicyPayloadSchema,
  updateResidenceAnchors,
  recordedLineageSuccession,
  reputationInputEvents,
  RELATIONS_FEATURE,
  recordedPossession,
  type TreatyAidFailure,
  type PersonnelMonthResult,
  type PersonnelStepPacket,
  type ReplayState,
  type WorldState,
  type NationLifecycleEffects,
} from '@opensamguk/rules';
import type { EngineFeature, QueuedInputHandler } from './features';
import { processHeritagePurchase } from './heritagePurchase';
import { processTroopInput } from './troopInput';
import { loadReplayState } from './monthly';
import { loadWorld } from './worldLoader';
import { loadOfficeRevisions, loadOfficeState, persistOfficeState } from './personnelState';
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
    // 복합 PK가 칸 중복을 금지한다. 개수와 양 끝 값으로 같은 연속 범위를 검증한다.
    const rows = await tx.$queryRaw<
      {
        id: number;
        defaultPolicy: string | null;
        userId: string | null;
        lastActiveTick: number | null;
        validSlots: boolean;
      }[]
    >`
      WITH turn_slots AS MATERIALIZED (
        SELECT "generalId", count(*) = 30 AND min(slot) = 0 AND max(slot) = 29 AS valid
        FROM "GeneralTurn" WHERE "worldId" = ${worldId}
        GROUP BY "generalId"
      )
      SELECT g.id, g."defaultPolicy", g."userId", g."lastActiveTick",
        COALESCE(t.valid, false) AS "validSlots"
      FROM "General" g
      LEFT JOIN turn_slots t ON t."generalId" = g.id
      WHERE g."worldId" = ${worldId}
      ORDER BY g.id
    `;
    if (rows.some((row) => !row.validSlots)) assertSlotSet([]);
    for (const row of rows) {
      if (!isPolicyKey(row.defaultPolicy)) throw new Error('저장된 기본 방침이 올바르지 않습니다.');
      if (row.userId !== null && row.lastActiveTick === null) throw new Error('사람 장수의 활동 tick이 없습니다.');
    }
  }
  const offices = await loadOfficeRevisions(tx, worldId);
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

const processNationRestrictions: QueuedInputHandler = async (tx, world, event, { tick }) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status === 'ENDED') return reject('WORLD_CLOSED', '종료된 월드입니다.');
  const input = nationRestrictionsInput.safeParse(event.payload);
  if (!input.success) return reject('BAD_RESTRICTION', '국가 제한을 확인하세요.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const actor =
    event.generalId === null
      ? null
      : await tx.general.findUnique({
          where: { worldId_id: { worldId: world.id, id: event.generalId } },
          select: { userId: true, officerLevel: true, nationId: true },
        });
  if (
    !actor ||
    actor.userId !== event.userId ||
    actor.officerLevel < NATION_RESTRICTIONS_MIN_OFFICE ||
    actor.nationId !== input.data.nationId
  )
    return reject('FORBIDDEN', '현재 소속국 수뇌부만 제한을 변경할 수 있습니다.');
  const where = { worldId_id: { worldId: world.id, id: input.data.nationId } };
  const nation = await tx.nation.findUniqueOrThrow({ where, select: { restrictions: true } });
  const state = nationRestrictions(world, storedNationRestrictions(true, nation.restrictions), tick);
  const changed = changeNationRestrictions(state, input.data);
  if (!changed) return reject('NO_WAR_CHANGES', '이번 달 출병 제한 변경 횟수가 남아 있지 않습니다.');
  await tx.nation.update({ where, data: { restrictions: changed } });
  return { status: 'APPLIED', result: changed };
};

const processNpcNationPolicy: QueuedInputHandler = async (tx, world, event) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status === 'ENDED') return reject('WORLD_CLOSED', '종료된 월드입니다.');
  const input = npcNationPolicyInput.safeParse(event.payload);
  if (!input.success) return reject('BAD_NPC_POLICY', 'NPC 운영 기준을 확인하세요.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const actor =
    event.generalId === null
      ? null
      : await tx.general.findUnique({
          where: { worldId_id: { worldId: world.id, id: event.generalId } },
          select: { userId: true, officerLevel: true, nationId: true },
        });
  if (
    !actor ||
    actor.userId !== event.userId ||
    actor.officerLevel !== BALANCE.RULER_LEVEL ||
    actor.nationId !== input.data.nationId
  )
    return reject('FORBIDDEN', '현재 군주만 NPC 운영 기준을 변경할 수 있습니다.');
  await tx.nation.update({
    where: { worldId_id: { worldId: world.id, id: input.data.nationId } },
    data: { npcSettings: input.data.policy },
  });
  return { status: 'APPLIED', result: input.data };
};

const processFinanceRates: QueuedInputHandler = async (tx, world, event) => {
  const request = financeRatesInput.safeParse(event.payload);
  if (!request.success || world.status === 'ENDED')
    return { status: 'REJECTED', result: { code: 'BAD_FINANCE_RATES' } };
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const actor =
    event.generalId === null
      ? null
      : await tx.general.findUnique({
          where: { worldId_id: { worldId: world.id, id: event.generalId } },
          select: {
            userId: true,
            nationId: true,
            officerLevel: true,
            removedAt: true,
            user: { select: { status: true } },
          },
        });
  if (
    !actor ||
    actor.userId !== event.userId ||
    actor.user?.status !== 'ACTIVE' ||
    actor.nationId !== request.data.nationId ||
    actor.officerLevel < 5 ||
    actor.removedAt !== null
  )
    return { status: 'REJECTED', result: { code: 'FORBIDDEN' } };
  await tx.nation.update({
    where: { worldId_id: { worldId: world.id, id: request.data.nationId } },
    data: { financeRates: request.data.rates },
  });
  return { status: 'APPLIED', result: request.data };
};

const processDefenseStance: QueuedInputHandler = async (tx, world, event) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status === 'ENDED') return reject('WORLD_CLOSED', '종료된 월드입니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  const where = { worldId_id: { worldId: world.id, id: event.generalId } };
  const general = await tx.general.findUnique({ where, select: { userId: true } });
  if (general?.userId !== event.userId) return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const stance = defenseStanceInput.safeParse(event.payload);
  if (!stance.success) return reject('BAD_STANCE', '수비 기준을 확인하세요.');
  await tx.general.update({ where, data: { defenseThreshold: stance.data.threshold } });
  return { status: 'APPLIED', result: stance.data };
};

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
  await persistEffects(
    tx,
    world.id,
    outcome.packet.state,
    [{ kind: 'world', state: outcome.packet.state }],
    {
      tick,
      sequence,
    },
    before.state,
  );
  await persistPersonnelPacket(tx, world.id, before, outcome.packet, anchors, { tick, sequence });
  return { status: 'APPLIED', result: outcome.result as unknown as Prisma.InputJsonValue };
};

export const builtInEngineFeatures: readonly EngineFeature[] = [
  { key: 'office-effects' },
  { key: 'nation-strategy-v1' },
  { key: 'prepared-turns-v1' },
  { key: 'nation-research-v1' },
  { key: RESEARCH_ERA_FEATURE },
  { key: 'court-rank-v1' },
  { key: COURT_PROMOTION_FEATURE },
  { key: CITY_SEASONAL_EVENTS_FEATURE },
  {
    key: INACTIVE_REMOVAL_FEATURE,
    async persistMonthly(tx, worldId, _before, _next, effects, { tick, sequence }) {
      const ids = z.array(z.number().int().positive()).parse(effects);
      if (!ids.length) return;
      await tx.general.updateMany({
        where: { worldId, id: { in: ids } },
        data: { lastActiveTick: null, lastActiveAt: null },
      });
      const last = await tx.generalLog.findFirst({
        where: { worldId, sequence },
        orderBy: { ordinal: 'desc' },
        select: { ordinal: true },
      });
      await tx.generalLog.createMany({
        data: ids.map((generalId, index) => ({
          worldId,
          generalId,
          tick,
          sequence,
          ordinal: (last?.ordinal ?? -1) + index + 1,
          commandKey: 'general.inactive-removal',
          kind: 'success',
          text: '장기 미접속으로 장수가 퇴장했습니다.',
        })),
      });
    },
  },
  { key: NATION_RESTRICTIONS_FEATURE, queuedInputs: { [NATION_RESTRICTIONS_KIND]: processNationRestrictions } },
  { key: NPC_NATION_POLICY_FEATURE, queuedInputs: { [NPC_NATION_POLICY_KIND]: processNpcNationPolicy } },
  { key: NATION_FINANCE_FEATURE, queuedInputs: { [NATION_FINANCE_KIND]: processFinanceRates } },
  { key: RANKED_PAYROLL_FEATURE },
  { key: WALL_INCOME_FEATURE },
  { key: WAR_INCOME_FEATURE },
  { key: CITY_CONFLICT_FEATURE },
  { key: STAT_GROWTH_FEATURE },
  { key: DEFENSE_STANCE_FEATURE, queuedInputs: { [DEFENSE_STANCE_KIND]: processDefenseStance } },
  { key: NATION_PHILOSOPHY_FEATURE },
  { key: PLAYER_AUTOPLAY_FEATURE },
  { key: 'general-condition-v1' },
  { key: GENERAL_PERSONALITY_FEATURE },
  { key: COMBAT_SPECIALTY_FEATURE },
  { key: BATTLE_TACTICS_FEATURE },
  { key: HERITAGE_BENEFITS_FEATURE, queuedInputs: { [HERITAGE_BENEFIT_KIND]: processHeritagePurchase } },
  { key: TROOP_FEATURE, queuedInputs: { [TROOP_ACTION_KIND]: processTroopInput } },
  { key: DOMESTIC_SPECIALTY_FEATURE },
  { key: GENERAL_PROFICIENCY_FEATURE },
  { key: 'rice-market-v1' },
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
  { key: 'border-return-v1' },
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
      await persistEffects(
        tx,
        world.id,
        packet.state,
        [{ kind: 'world', state: packet.state }],
        { tick: input.tick!, sequence: input.sequence },
        state,
      );
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
      ...(await loadTreaties(tx, worldId, treatyOptions(state.ruleFeatures ?? []))),
    }),
    queuedInputs: {
      'treaty.propose': (tx, world, event, context) =>
        processTreatyQueuedInput(tx, world, event, {
          ...context,
          treatyTradeEnabled: world.ruleFeatures.includes('treaty-trade'),
          treatyExpandedEnabled: world.ruleFeatures.includes(EXPANDED_TREATY_FEATURE),
        }),
      'treaty.respond': (tx, world, event, context) =>
        processTreatyQueuedInput(tx, world, event, {
          ...context,
          treatyTradeEnabled: world.ruleFeatures.includes('treaty-trade'),
          treatyExpandedEnabled: world.ruleFeatures.includes(EXPANDED_TREATY_FEATURE),
        }),
    },
    async persistMonthly(tx, worldId, before, next, effects, context) {
      await persistTreatyClosures(tx, worldId, before.state, next.state, context);
      for (const failure of effects as readonly TreatyAidFailure[])
        await appendNationHistory(tx, worldId, context.tick, failure.nationId, failure.text);
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
          treatyExpandedEnabled: world.ruleFeatures.includes(EXPANDED_TREATY_FEATURE),
        }),
    },
  },
  { key: 'treaty-trade' },
  { key: EXPANDED_TREATY_FEATURE },
  { key: 'ranked-aid-v1' },
  { key: DIPLOMATIC_COOLDOWN_FEATURE },
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
