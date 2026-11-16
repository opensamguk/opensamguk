import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { DeepReadonly, WorldView } from '../model/world';
import { readCampaignState } from './state';
import type { UnitSetResource } from '../world/resources';
import { battleBusy } from '../tactical/world';

const integer = z.number().int().min(0).max(2_147_483_647),
  id = integer.min(1);
export const campaignUnitInputSchema = z.strictObject({
  type: z.literal('command'),
  unitId: id,
  commanderId: id,
  revision: integer,
});
export type CampaignUnitInput = z.infer<typeof campaignUnitInputSchema>;

// 편성 입력은 병력을 생성하거나 General/군량에서 옮기지 않는다. 모병·소집해제는 기존 예약 명령이다.
export function applyCampaignUnitInput(
  world: WorldView,
  value: unknown,
  actorId: number,
  campaignValue: unknown,
  context: {
    tick: number;
    userId: string;
    userActive: boolean;
    armyTypes: readonly number[];
    unitSet: DeepReadonly<UnitSetResource>;
  },
) {
  const deny = (code: string, message: string) => ({ ok: false as const, code, message });
  const current = readCampaignState(campaignValue, world);
  if (world.campaign && JSON.stringify(readCampaignState(world.campaign, world)) !== JSON.stringify(current))
    throw new Error('월드와 부곡 입력의 저장 상태가 다릅니다.');
  integer.parse(context.tick);
  const parsed = campaignUnitInputSchema.safeParse(value);
  if (!parsed.success) return deny('BAD_INPUT', '부곡 입력을 확인하세요.');
  const actor = world.generals[actorId];
  if (!context.userActive || !actor || !context.userId || actor.userId !== context.userId)
    return deny('ACTOR_INACTIVE', '활성 계정의 자기 장수만 편성할 수 있습니다.');
  const input = parsed.data;
  if (battleBusy(world, { generalIds: [actorId, input.commanderId], unitIds: [input.unitId] }))
    return deny('BATTLE_BUSY', '전투 중');
  if (input.revision !== current.revision) return deny('STALE_REVISION', '휘하 현황을 다시 불러오세요.');
  if (current.revision === 2_147_483_647) return deny('REVISION_LIMIT', '휘하 변경 번호 한도를 넘었습니다.');
  const next = structuredClone(current),
    state = cloneWorld(world);
  const unit = next.units.find((unit) => unit.id === input.unitId);
  if (!unit || unit.ownerId !== actorId) return deny('NOT_ALLOWED', '자기 부곡만 편성할 수 있습니다.');
  let unitId: number, commanderId: number;
  {
    const commander = world.generals[input.commanderId];
    if (
      !commander ||
      commander.nationId !== actor.nationId ||
      (commander.id !== actorId &&
        (commander.userId !== null ||
          !current.links.some(
            (link) => link.masterId === actorId && link.personId === commander.id && link.relation === 'LIEUTENANT',
          )))
    )
      return deny('BAD_COMMANDER', '본인 또는 직속 NPC 부장만 지휘할 수 있습니다.');
    if (!world.cities[actor.cityKey] || commander.cityKey !== actor.cityKey)
      return deny('MUST_ASSEMBLE', '같은 도시 또는 관문에 모여야 합니다.');
    if (unit && unit.troops > 0 && world.generals[unit.commanderId]!.cityKey !== actor.cityKey)
      return deny('MUST_ASSEMBLE', '기존 지휘관과 병력도 같은 거점에 모여야 합니다.');
    if (commander.activeFromYear > world.startYear + Math.floor(context.tick / (12 * TICKS_PER_MONTH)))
      return deny('BAD_COMMANDER', '아직 등장하지 않은 장수입니다.');
    const commanded = next.units
      .filter((row) => row.commanderId === commander.id && row.id !== unit?.id)
      .reduce((sum, row) => sum + row.troops, 0);
    if (commanded + (unit?.troops ?? 0) > commander.leadership * 100)
      return deny('COMMAND_CAPACITY', '실제 지휘관의 전체 병력 상한을 넘습니다.');
    commanderId = commander.id;
    unitId = unit!.id;
    unit!.commanderId = commanderId;
  }
  next.revision++;
  if (state.campaign) state.campaign = next;
  readCampaignState(next, state, current.seed);
  return { ok: true as const, state, campaign: next, result: { unitId, commanderId, revision: next.revision } };
}
