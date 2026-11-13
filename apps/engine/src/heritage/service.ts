import {
  creationRefunds,
  seasonHeritageAwards,
  heritageSpecialtyCost,
  SPECIALTY_GROWTH_FEATURE,
  type WorldView,
} from '@opensamguk/rules';
import type { HeritageRepository, HeritageSeason } from './port';

export async function creditHeritageSeason(repository: HeritageRepository, season: HeritageSeason) {
  const awards = seasonHeritageAwards({
    ...season,
    activity: await repository.activity(season.worldId, season.endedSequence),
  });
  const eligible = [];
  for (const award of awards) if ((await repository.lockUser(award.userId)) === 'OPEN') eligible.push(award);
  for (const award of eligible) {
    await repository.append({
      userId: award.userId,
      worldId: season.worldId,
      key: `credit:${season.worldId}`,
      kind: 'SEASON_CREDIT',
      delta: award.total,
      detail: {
        version: 1,
        reason: season.reason,
        activityMonths: award.activityMonths,
        activityPoints: award.activityPoints,
        winPoints: award.winPoints,
        finalStateHash: season.finalStateHash,
      },
    });
  }
}

export async function refundHeritageCreations(
  repository: HeritageRepository,
  worldId: string,
  reason: 'ADMIN_END' | 'ADMIN_RESET',
  context: { requestId: string; newWorldId?: string },
) {
  const spends = await repository.creationSpends(worldId),
    withdrawnUserIds = new Set<string>();
  for (const userId of [...new Set(spends.map((entry) => entry.userId))].sort()) {
    const status = await repository.lockUser(userId);
    if (status === null) throw new Error('유산 사용 원장의 계정이 없습니다.');
    if (status === 'WITHDRAWN') withdrawnUserIds.add(userId);
  }
  for (const entry of creationRefunds({
    worldId,
    reason,
    spends,
    existingKeys: await repository.refundKeys(worldId),
    withdrawnUserIds,
  }))
    await repository.append({
      ...entry,
      detail: {
        version: 1,
        reason,
        spendKey: entry.detail.sourceKey,
        requestId: context.requestId,
        ...(context.newWorldId === undefined ? {} : { newWorldId: context.newWorldId }),
      },
    });
}

export async function refundRemovedGeneralSpecialties(
  repository: HeritageRepository,
  worldId: string,
  before: WorldView,
  after: WorldView,
  generalIds: readonly number[],
) {
  if (!before.ruleFeatures?.includes(SPECIALTY_GROWTH_FEATURE)) return;
  const refunds = generalIds
    .flatMap((id) => {
      const old = before.generals[id];
      const next = after.generals[id];
      const specialty = next?.heritageSpecialty?.next;
      return old?.userId && old.removedAt === undefined && next?.removedAt !== undefined && specialty
        ? [{ id, userId: old.userId, specialty }]
        : [];
    })
    .sort((a, b) => a.userId.localeCompare(b.userId));
  for (const { id, userId, specialty } of refunds) {
    if ((await repository.lockUser(userId)) !== 'OPEN') continue;
    await repository.append({
      userId,
      worldId,
      key: `specialty-refund:${worldId}:${id}`,
      kind: 'SPECIALTY_REFUND',
      delta: heritageSpecialtyCost,
      detail: { version: 1, generalId: id, specialty, reason: 'GENERAL_REMOVED' },
    });
  }
}
