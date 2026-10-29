import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';
import type { RecordedInput } from '../replay';
import { applyCityAllocation, cityAllocationArgs } from './allocation';

const integer = z.number().int().min(0).max(2_147_483_647);
export const cityResourceInputSchema = cityAllocationArgs;
export const cityResourceResultSchema = cityAllocationArgs.extend({ revision: integer.min(1), tick: integer });
const rejectionSchema = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });

export function applyCityResourceInput(
  world: WorldView,
  value: unknown,
  actorId: number,
  context: { tick: number; userId: string; userActive: boolean; armyTypes: readonly number[] },
) {
  const deny = (code: string, message: string) => ({ ok: false as const, code, message });
  integer.parse(context.tick);
  const actor = world.generals[actorId];
  if (!context.userActive || !actor || !context.userId || actor.userId !== context.userId)
    return deny('ACTOR_INACTIVE', '활성 계정의 자기 장수만 배속할 수 있습니다.');
  if (actor.activeFromYear > world.startYear + Math.floor(context.tick / (12 * TICKS_PER_MONTH)))
    return deny('ACTOR_INACTIVE', '아직 등장하지 않은 장수입니다.');
  const parsed = cityResourceInputSchema.safeParse(value);
  if (!parsed.success) return deny('BAD_INPUT', '도시 병력 배속 입력을 확인하세요.');
  const ownerId = world.campaign?.units.find((row) => row.id === parsed.data.unitId)?.ownerId;
  const commanderId = world.campaign?.units.find((row) => row.id === parsed.data.unitId)?.commanderId;
  const year = world.startYear + Math.floor(context.tick / (12 * TICKS_PER_MONTH));
  if ([ownerId, commanderId].some((id) => id !== undefined && world.generals[id]!.activeFromYear > year))
    return deny('BAD_TARGET', '아직 등장하지 않은 부곡 인물에게 배속할 수 없습니다.');
  const outcome = applyCityAllocation(
    world,
    { generalId: actorId, tick: context.tick },
    parsed.data,
    context.armyTypes,
  );
  if (!outcome.ok) return outcome;
  return {
    ...outcome,
    result: cityResourceResultSchema.parse({
      ...parsed.data,
      revision: outcome.state.campaign!.revision,
      tick: context.tick,
    }),
  };
}

export function validateCityResourceRecord(input: RecordedInput): void {
  if (input.kind !== 'city.resources') throw new Error('도시 자원 입력 종류를 확인하세요.');
  integer.min(1).parse(input.sequence);
  integer.parse(input.tick);
  if (input.status === 'REJECTED') {
    rejectionSchema.parse(input.result);
    return;
  }
  integer.min(1).parse(input.generalId);
  const payload = cityResourceInputSchema.parse(input.payload),
    result = cityResourceResultSchema.parse(input.result);
  if (result.tick !== input.tick) throw new Error('도시 자원 처리 tick이 기록과 다릅니다.');
  if ((['cityKey', 'unitId', 'crewType', 'amount'] as const).some((key) => payload[key] !== result[key]))
    throw new Error('도시 자원 입력과 처리 결과의 대상·수량이 다릅니다.');
}

export function replayCityResourceInput(world: WorldView, input: RecordedInput, armyTypes: readonly number[]) {
  validateCityResourceRecord(input);
  if (input.status === 'REJECTED') return world;
  const actor = world.generals[input.generalId!];
  if (!actor?.userId) throw new Error('도시 자원 입력의 사람 장수가 없습니다.');
  const outcome = applyCityResourceInput(world, input.payload, actor.id, {
    tick: input.tick!,
    userId: actor.userId,
    userActive: true,
    armyTypes,
  });
  if (!outcome.ok || JSON.stringify(outcome.result) !== JSON.stringify(cityResourceResultSchema.parse(input.result)))
    throw new Error('도시 병력 배속 기록을 재현하지 못했습니다.');
  return outcome.state;
}
