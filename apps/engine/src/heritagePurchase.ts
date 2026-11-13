import {
  BATTLE_TACTICS_FEATURE,
  HERITAGE_SPECIALTY_KIND,
  HERITAGE_TURN_TIME_KIND,
  HERITAGE_STAT_RESET_KIND,
  POSSESSION_KIND,
  heritageStatResetInput,
  purchaseHeritageStatReset,
  statRulesSchema,
  heritageTurnTimeInput,
  purchaseHeritageTurnTime,
  storedHeritageTurnTime,
  heritageSpecialtyInput,
  heritageSpecialtyPurchase,
  storedHeritageSpecialty,
  battleHeritageBenefits,
  heritageBenefitInput,
  heritagePurchase,
  storedHeritageBenefits,
} from '@opensamguk/rules';
import type { QueuedInputHandler } from './features';
import { databaseNow } from './lease';

export const processHeritagePurchase: QueuedInputHandler = async (tx, world, event, { sequence, emit }) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  const specialtyAction =
    event.kind === HERITAGE_SPECIALTY_KIND ? heritageSpecialtyInput.safeParse(event.payload) : undefined;
  const timingAction =
    event.kind === HERITAGE_TURN_TIME_KIND ? heritageTurnTimeInput.safeParse(event.payload) : undefined;
  const statAction =
    event.kind === HERITAGE_STAT_RESET_KIND ? heritageStatResetInput.safeParse(event.payload) : undefined;
  const action =
    specialtyAction || timingAction || statAction ? undefined : heritageBenefitInput.safeParse(event.payload);
  if (
    specialtyAction?.success === false ||
    timingAction?.success === false ||
    statAction?.success === false ||
    action?.success === false
  )
    return reject('BAD_BENEFIT', '구매할 유산 혜택을 확인하세요.');
  if (
    action?.success &&
    (battleHeritageBenefits as readonly string[]).includes(action.data.benefit) &&
    !world.ruleFeatures.includes(BATTLE_TACTICS_FEATURE)
  )
    return reject('NOT_ENABLED', '이 월드에서 전투계략과 필살을 켜지 않았습니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const now = await databaseNow(tx);
  const sanction = await tx.sanction.findFirst({
    where: {
      userId: event.userId,
      AND: [
        { OR: [{ worldId: null }, { worldId: world.id }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
      liftedAt: null,
    },
    select: { id: true },
  });
  if (sanction) return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  const where = { worldId_id: { worldId: world.id, id: event.generalId } };
  const general = await tx.general.findUnique({
    where,
    select: {
      userId: true,
      removedAt: true,
      heritageBenefits: true,
      special: true,
      combatSpecial: true,
      heritageSpecialty: true,
      heritageTurnTime: true,
      heritageStatReset: true,
      nextTurnTick: true,
      id: true,
    },
  });
  if (general?.userId !== event.userId || general.removedAt !== null)
    return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const { heritageBenefits } = storedHeritageBenefits(true, general.heritageBenefits);
  const specialty = specialtyAction?.success
    ? heritageSpecialtyPurchase(
        world,
        {
          special: general.special,
          ...(general.heritageSpecialty === null ? {} : { combatSpecial: general.combatSpecial }),
          ...storedHeritageSpecialty(true, general.heritageSpecialty),
        },
        specialtyAction.data,
      )
    : null;
  const benefit = action?.success ? heritagePurchase(heritageBenefits, action.data) : null;
  const timing = timingAction?.success
    ? purchaseHeritageTurnTime(
        { id: general.id, nextTurnTick: general.nextTurnTick, ...storedHeritageTurnTime(general.heritageTurnTime) },
        world.seed,
        timingAction.data.expectedCost,
      )
    : null;
  if (
    statAction?.success &&
    (await tx.inputEvent.findFirst({
      where: { worldId: world.id, generalId: general.id, kind: POSSESSION_KIND, status: 'APPLIED' },
      select: { id: true },
    }))
  )
    return reject('NOT_ELIGIBLE', '맡은 NPC 장수의 능력치는 초기화할 수 없습니다.');
  const reset = statAction?.success
    ? purchaseHeritageStatReset(
        { id: general.id, ...(general.heritageStatReset ? { heritageStatReset: true as const } : {}) },
        statRulesSchema.parse({ stat: world.statRules }).stat,
        world.seed,
        statAction.data,
      )
    : null;
  const purchase = reset ?? timing ?? specialty ?? benefit;
  if (!purchase)
    return reject(
      'ALREADY_OWNED',
      statAction
        ? '이미 초기화했거나 배분 능력치가 바뀌었습니다.'
        : timingAction
          ? '턴 시간 초기화 비용이나 예약 상태가 바뀌었습니다.'
          : specialtyAction
            ? '현재 선택한 특기 요청을 처리할 수 없습니다.'
            : '이미 같은 단계 이상의 혜택을 보유했습니다.',
    );
  if (purchase.cost > 0) {
    const debit = await tx.heritageAccount.updateMany({
      where: { userId: event.userId, balance: { gte: purchase.cost } },
      data: { balance: { decrement: purchase.cost } },
    });
    if (debit.count !== 1) return reject('HERITAGE_INSUFFICIENT', '유산 포인트가 부족합니다.');
    await tx.heritageEntry.create({
      data: {
        userId: event.userId,
        worldId: world.id,
        key: `benefit:${world.id}:${sequence}`,
        kind: 'BENEFIT_SPEND',
        delta: -purchase.cost,
        detail: purchase,
      },
    });
  }
  await tx.general.update({
    where,
    data: reset
      ? { ...reset.stats, heritageStatReset: true }
      : timing
        ? { heritageTurnTime: timing.heritageTurnTime }
        : specialty
          ? { combatSpecial: specialty.combatSpecial, heritageSpecialty: specialty.heritageSpecialty }
          : { heritageBenefits: { ...heritageBenefits, [benefit!.benefit]: benefit!.level } },
  });
  if (reset || timing || specialty) emit?.({ kind: 'turn.result', target: { generalId: general.id } });
  return { status: 'APPLIED', result: purchase };
};
