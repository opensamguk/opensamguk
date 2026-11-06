import { TICKS_PER_MONTH } from '../clock/constants';
import { ADMIN_CLOCK_KINDS } from '../clock/admin';
import { ADMIN_END_KIND } from '../clock/end';
import { ADMIN_RESET_KIND } from '../clock/reset';
import { ADMIN_GAME_KINDS } from '../admin/game';
import { ADMIN_SETTING_KINDS } from '../admin/settings';

export const HERITAGE_DIRECT_INPUT_KINDS = [
  'turns.set',
  'nationTurns.set',
  'general.setPolicy',
  'personnel.appoint',
  'personnel.dismiss',
  'offer.respond',
  'treaty.propose',
  'treaty.respond',
  'treaty.break',
  'campaign.relationship',
  'campaign.unit',
  'campaign.order',
  'city.resources',
  'logistics.order',
  'governance.act',
  'lineage.act',
  'stratagem-cards.act',
] as const;
export const HERITAGE_IGNORED_INPUT_KINDS = [
  'general.active',
  'general.create',
  'general.possess',
  'system.policy.enable',
  ...ADMIN_CLOCK_KINDS,
  ADMIN_END_KIND,
  ADMIN_RESET_KIND,
  ...ADMIN_GAME_KINDS,
  ...ADMIN_SETTING_KINDS,
] as const;
const directKinds = new Set<string>(HERITAGE_DIRECT_INPUT_KINDS);

export interface HeritageActivityInput {
  userId: string;
  kind: string;
  status: string;
  sequence: number | null;
  tick: number | null;
  result: unknown;
}

export function heritageActivityMonths(
  inputs: readonly HeritageActivityInput[],
  endedSequence: number,
): Map<string, number> {
  if (!Number.isSafeInteger(endedSequence) || endedSequence < 0) throw new Error('종료 입력 순번을 확인하세요.');
  const months = new Map<string, Set<number>>();
  for (const row of inputs) {
    if (row.status !== 'APPLIED' || !directKinds.has(row.kind)) continue;
    if (row.sequence === null || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
      throw new Error('직접 명령의 입력 순번이 없습니다.');
    if (row.sequence > endedSequence) continue;
    const result = row.result;
    const activeTick =
      result !== null && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).activeTick
        : undefined;
    const tick = row.tick ?? activeTick;
    if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0)
      throw new Error('직접 명령의 활동 시각이 없습니다.');
    const own = months.get(row.userId) ?? new Set<number>();
    own.add(Math.floor(tick / TICKS_PER_MONTH));
    months.set(row.userId, own);
  }
  return new Map([...months].map(([userId, active]) => [userId, active.size]));
}
