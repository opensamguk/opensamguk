import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { CommandResolver } from '../commands/resolve';
import type { Actor } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView, WorldState } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { chooseGeneralTurn } from '../npc';
import { readCampaignState } from './state';
import { campaignOrderInputSchema, campaignOrderSlotSchema, sameOrderValue, type CampaignOrder } from './orderTypes';

const NPC_ORDER_CATEGORIES: ReadonlySet<string> = new Set(['domestic', 'military', 'personal']);

export function canIssueCampaignOrder(world: WorldView, issuerId: number, recipientId: number): boolean {
  const issuer = world.generals[issuerId],
    recipient = world.generals[recipientId];
  return (
    !!issuer &&
    !!recipient &&
    issuerId !== recipientId &&
    issuer.nationId !== null &&
    issuer.nationId === recipient.nationId &&
    !!world.nations[issuer.nationId] &&
    (issuer.officerLevel === 12 ||
      !!world.campaign?.links.some((link) => link.masterId === issuerId && link.personId === recipientId))
  );
}
export function campaignNpcSuperior(world: WorldView, recipientId: number): number | null {
  const recipient = world.generals[recipientId];
  if (!recipient || recipient.nationId === null) return null;
  const direct = world.campaign?.links.find((link) => link.personId === recipientId)?.masterId;
  if (direct !== undefined)
    return world.generals[direct]?.userId === null && canIssueCampaignOrder(world, direct, recipientId) ? direct : null;
  return (
    Object.values(world.generals)
      .filter(
        (general) =>
          general.userId === null &&
          general.officerLevel === 12 &&
          canIssueCampaignOrder(world, general.id, recipientId),
      )
      .sort((a, b) => a.id - b.id)[0]?.id ?? null
  );
}
function currentOrderAuthority(
  world: WorldView,
  order: Readonly<Pick<CampaignOrder, 'issuerId' | 'recipientId' | 'nationId' | 'authority'>>,
) {
  return (
    canIssueCampaignOrder(world, order.issuerId, order.recipientId) &&
    world.generals[order.issuerId]!.nationId === order.nationId &&
    world.generals[order.recipientId]!.nationId === order.nationId &&
    (order.authority === 'DIRECT'
      ? !!world.campaign?.links.some((link) => link.masterId === order.issuerId && link.personId === order.recipientId)
      : world.generals[order.issuerId]!.officerLevel === 12)
  );
}
export type CampaignOrderContext = {
  tick: number;
  userId: string;
  userActive: boolean;
  resolver: CommandResolver;
  turns: Readonly<Record<number, readonly { commandKey: string; args: unknown; explicit?: boolean }[]>>;
  revisions: Readonly<Record<number, number>>;
  unitSet: UnitSetResource;
};
type Outcome =
  | { ok: true; state: WorldState; result: { orderId: number; revision: number } }
  | { ok: false; code: string; message: string };
export function applyCampaignOrder(
  world: WorldView,
  value: unknown,
  actorId: number,
  context: CampaignOrderContext,
): Outcome {
  const deny = (code: string, message: string): Outcome => ({ ok: false, code, message });
  const parsed = campaignOrderInputSchema.safeParse(value),
    actor = world.generals[actorId];
  if (!parsed.success) return deny('BAD_ARGS', '휘하 지시 입력을 확인하세요.');
  if (!actor || actor.userId !== context.userId || !context.userActive)
    return deny('NOT_ALLOWED', '자신의 활성 장수로 요청하세요.');
  const campaign = readCampaignState(world.campaign, world),
    input = parsed.data;
  if (input.revision !== campaign.revision) return deny('STALE', '휘하 현황이 바뀌었습니다.');
  if (campaign.revision === 2_147_483_647) return deny('AT_MAX', '휘하 변경 번호 한도입니다.');
  const orders = campaign.orders ?? { version: 1 as const, nextId: 1, items: [] };
  let order: CampaignOrder;
  if (input.type === 'respond') {
    const found = orders.items.find((item) => item.id === input.orderId);
    if (!found || found.recipientId !== actorId || found.status !== 'PENDING')
      return deny('NOT_ALLOWED', '자신에게 온 미처리 지시만 응답하세요.');
    order = found;
    if (input.accept) {
      if (!currentOrderAuthority(world, order)) return deny('NOT_ALLOWED', '현재 지시 권한이 없습니다.');
      if (
        context.revisions[actorId] !== input.expectedTurnRevision ||
        !sameOrderValue(context.turns[actorId]?.[0], input.expectedFirstSlot)
      )
        return deny('STALE', '다음 예약이 바뀌었습니다. 다시 확인하세요.');
      order.turnRevision = input.expectedTurnRevision;
      order.firstSlot = input.expectedFirstSlot;
      order.status = 'READY';
    } else {
      order.status = 'REJECTED';
      order.result = '지시를 거절했습니다.';
      order.resolvedTick = context.tick;
    }
  } else {
    const recipientId = input.type === 'issue' ? input.recipientId : actorId;
    const issuerId = input.type === 'issue' ? actorId : campaignNpcSuperior(world, actorId);
    if (issuerId === null || !canIssueCampaignOrder(world, issuerId, recipientId))
      return deny('NOT_ALLOWED', '현재 상관 또는 군주만 지시할 수 있습니다.');
    if (orders.items.some((item) => item.recipientId === recipientId && ['PENDING', 'READY'].includes(item.status)))
      return deny('PENDING', '아직 처리하지 않은 지시가 있습니다.');
    if (orders.nextId === 2_147_483_647) return deny('AT_MAX', '지시 번호 한도입니다.');
    const recipient = world.generals[recipientId]!;
    const year = world.startYear + Math.floor(context.tick / (12 * TICKS_PER_MONTH));
    if (recipient.activeFromYear > year || world.generals[issuerId]!.activeFromYear > year)
      return deny('NOT_ALLOWED', '아직 활동하지 않는 장수입니다.');
    const chosen =
      input.type === 'issue'
        ? input.command
        : (() => {
            const selected = chooseGeneralTurn(
              world,
              { ...recipient, userId: null },
              rngFor(campaign.seed, 'campaign-order', context.tick, issuerId, recipientId, orders.nextId),
              { tick: context.tick, resolver: context.resolver, unitSet: context.unitSet },
            ).chosen;
            return selected ? { commandKey: selected.key, args: selected.args } : null;
          })();
    if (!chosen) return deny('BAD_STATE', '현재 수행할 지시가 없습니다.');
    const definition = context.resolver.get(chosen.commandKey);
    if (!definition || definition.target !== 'general' || !definition.args.safeParse(chosen.args).success)
      return deny('BAD_ARGS', '이 월드의 장수 명령과 인자를 선택하세요.');
    // 본인 동의 없이 바로 실행되는 NPC 지시는 내정·이동·귀환·자기 부곡과 개인 명령으로 한정한다.
    // 소속 변경·등용·계략(strategy)은 지시로 시키지 않는다.
    if (recipient.userId === null && !NPC_ORDER_CATEGORIES.has(definition.category))
      return deny('NOT_ALLOWED', 'NPC에게는 내정·이동·귀환·부곡 명령만 지시할 수 있습니다.');
    order = {
      id: orders.nextId++,
      issuerId,
      recipientId,
      nationId: recipient.nationId!,
      authority: campaign.links.some((link) => link.masterId === issuerId && link.personId === recipientId)
        ? 'DIRECT'
        : 'SOVEREIGN',
      command: chosen as CampaignOrder['command'],
      status: recipient.userId === null ? 'READY' : 'PENDING',
      createdTick: context.tick,
      turnRevision: null,
      firstSlot: null,
      result: null,
      resolvedTick: null,
    };
    if (order.status === 'READY') {
      const first = campaignOrderSlotSchema.safeParse(context.turns[recipientId]?.[0]);
      if (!first.success || !Number.isInteger(context.revisions[recipientId]))
        return deny('BAD_STATE', '수신 장수의30칸 예약을 확인하세요.');
      order.firstSlot = first.data;
      order.turnRevision = context.revisions[recipientId]!;
    }
    orders.items.push(order);
  }
  campaign.orders = orders;
  campaign.revision++;
  const state = cloneWorld(world);
  state.campaign = readCampaignState(campaign, state);
  if (input.type !== 'respond') {
    const failure = context.resolver.precheck(
      state,
      {
        generalId: order.recipientId,
        tick: context.tick,
        unitSet: context.unitSet,
        ...(order.status === 'READY' ? { campaignOrderId: order.id } : {}),
      },
      order.command.commandKey,
      order.command.args,
    );
    if (failure) return deny(failure.code, failure.message);
  }
  return { ok: true, state, result: { orderId: order.id, revision: campaign.revision } };
}

// 이 표지는 HTTP 입력이 아니다. 실제 차례의 저장 지시·권한을 다시 대조할 때만 사용한다.
export function hasCampaignOrderAuthority(world: WorldView, actor: Actor, key: string, value: unknown): boolean {
  const order = world.campaign?.orders?.items.find((item) => item.id === actor.campaignOrderId);
  return (
    !!order &&
    order.status === 'READY' &&
    order.recipientId === actor.generalId &&
    order.command.commandKey === key &&
    sameOrderValue(order.command.args, value) &&
    currentOrderAuthority(world, order)
  );
}
export function takeCampaignOrder(
  world: WorldView,
  actorId: number,
  revision: number | undefined,
  firstSlot: unknown,
  tick: number,
) {
  const found = world.campaign?.orders?.items.find((item) => item.recipientId === actorId && item.status === 'READY');
  if (!found) return { state: world, order: null };
  const state = cloneWorld(world),
    campaign = readCampaignState(state.campaign, state);
  const order = campaign.orders!.items.find((item) => item.id === found.id)!;
  if (
    !currentOrderAuthority(world, order) ||
    revision !== order.turnRevision ||
    !sameOrderValue(firstSlot, order.firstSlot)
  ) {
    order.status = 'CANCELLED';
    order.result = '권한 또는 다음 예약이 바뀌어 지시를 취소했습니다.';
    order.resolvedTick = tick;
    if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도입니다.');
    campaign.revision++;
    state.campaign = campaign;
    return { state, order: null };
  }
  return { state: world, order: found };
}
export function finishCampaignOrder(
  world: WorldView,
  orderId: number,
  tick: number,
  failure: boolean,
  result: string,
): WorldState {
  const state = cloneWorld(world),
    campaign = readCampaignState(state.campaign, state);
  const order = campaign.orders?.items.find((item) => item.id === orderId);
  if (!order || order.status !== 'READY' || campaign.revision === 2_147_483_647)
    throw new Error('실행할 저장 지시를 확인하세요.');
  order.status = failure ? 'FAILED' : 'EXECUTED';
  order.result = result;
  order.resolvedTick = tick;
  campaign.revision++;
  state.campaign = readCampaignState(campaign, state);
  return state;
}
