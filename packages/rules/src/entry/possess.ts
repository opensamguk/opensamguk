import { z } from 'zod';
import type { ClockStatus } from '../clock/clock';
import { HUMAN_GENERAL_LIMIT } from '../general/creationBlock';
import { lineageActive } from '../lineage/eligibility';
import type { WorldView } from '../model/world';
import type { RecordedInput, ReplayState } from '../replay';

export const POSSESSION_KIND = 'general.possess';
const integer = z.number().int().min(0).max(2_147_483_647);
const id = integer.min(1);
export const possessionPayloadSchema = z.strictObject({ generalId: id, userId: z.uuid() });
export const POSSESSION_ERRORS = {
  TAKEN: '이미 다른 사람이 맡은 장수입니다.',
  ALREADY_HAS_GENERAL: '이미 이 판에서 맡은 장수가 있습니다.',
  NOT_ELIGIBLE: '지금은 이 장수를 맡을 수 없습니다.',
  WORLD_FULL: '이 판의 장수 정원에 닿았습니다.',
  ENTRY_CLOSED: '이 판은 NPC 장수 맡기를 허용하지 않습니다.',
  ACTOR_INACTIVE: '장수를 맡을 수 없는 계정입니다.',
  ACTOR_SANCTIONED: '이 월드의 이용이 제한됐습니다.',
} as const;
export type PossessionCode = keyof typeof POSSESSION_ERRORS;
export const possessionRejectedSchema = z
  .strictObject({
    code: z.enum(Object.keys(POSSESSION_ERRORS) as [PossessionCode, ...PossessionCode[]]),
    message: z.string(),
  })
  .refine((value) => value.message === POSSESSION_ERRORS[value.code]);
export const possessionAppliedSchema = z.strictObject({
  generalId: id,
  userId: z.uuid(),
  revision: id,
  rulerNationId: id.nullable(),
  activeTick: integer.optional(),
});
export const possessionFailure = (code: PossessionCode) => ({ code, message: POSSESSION_ERRORS[code] });

export function availableNpc(world: WorldView, generalId: number, tick: number): boolean {
  return world.generals[generalId]?.userId === null && lineageActive(world, generalId, tick);
}

export function validatePossessionRecord(input: RecordedInput): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
    throw Error('장수 맡기 기록의 필드를 확인하세요.');
  id.parse(input.sequence);
  integer.parse(input.tick);
  if (input.kind !== POSSESSION_KIND) throw Error('장수 맡기 입력 종류가 다릅니다.');
  z.json().parse(input.payload);
  z.json().parse(input.result);
  const payload = possessionPayloadSchema.parse(input.payload);
  if (input.status === 'REJECTED') {
    if (input.generalId !== null) throw Error('거절된 맡기 기록에 적용 장수가 있습니다.');
    possessionRejectedSchema.parse(input.result);
    return;
  }
  if (input.status !== 'APPLIED') throw Error('완료한 장수 맡기 기록이 필요합니다.');
  const result = possessionAppliedSchema.parse(input.result);
  if (
    input.generalId !== payload.generalId ||
    result.generalId !== payload.generalId ||
    result.userId !== payload.userId ||
    (result.activeTick !== undefined && result.activeTick !== input.tick)
  )
    throw Error('장수 맡기 입력과 결과가 다릅니다.');
}

export function applyPossessionInput(replay: ReplayState, input: RecordedInput): ReplayState {
  validatePossessionRecord(input);
  if (input.status === 'REJECTED') return replay;
  const { generalId, userId } = possessionPayloadSchema.parse(input.payload);
  const result = possessionAppliedSchema.parse(input.result);
  const general = replay.state.generals[generalId];
  if (
    !availableNpc(replay.state, generalId, input.tick!) ||
    Object.values(replay.state.generals).some((candidate) => candidate.userId === userId) ||
    !Number.isSafeInteger(replay.revisions[generalId]) ||
    result.revision !== replay.revisions[generalId]! + 1 ||
    result.rulerNationId !== (general?.officerLevel === 12 ? general.nationId : null) ||
    (replay.policy ? result.activeTick !== input.tick : Object.hasOwn(result, 'activeTick'))
  )
    throw Error('장수 맡기 이전 상태와 기록이 다릅니다.');
  const next = structuredClone(replay);
  next.state.generals[generalId]!.userId = userId;
  next.revisions[generalId] = result.revision;
  if (result.rulerNationId !== null) {
    const nation = next.state.nations[result.rulerNationId];
    if (!nation) throw Error('맡은 군주의 국가가 없습니다.');
    nation.isNpc = false;
  }
  if (next.policy) next.policy.lastActiveTicks[generalId] = result.activeTick!;
  return next;
}

export function decidePossession(
  replay: ReplayState,
  payload: z.infer<typeof possessionPayloadSchema>,
  context: {
    tick: number;
    status: ClockStatus;
    npcPlay: boolean;
    userActive: boolean;
    sanctioned: boolean;
    replayFormat: number;
  },
):
  | { status: 'REJECTED'; result: ReturnType<typeof possessionFailure> }
  | { status: 'APPLIED'; result: z.infer<typeof possessionAppliedSchema> } {
  possessionPayloadSchema.parse(payload);
  integer.parse(context.tick);
  const reject = (code: PossessionCode) => ({ status: 'REJECTED' as const, result: possessionFailure(code) });
  if (!context.userActive) return reject('ACTOR_INACTIVE');
  if (context.sanctioned) return reject('ACTOR_SANCTIONED');
  if (context.replayFormat !== 3 || !['PREOPEN', 'RUNNING'].includes(context.status)) return reject('NOT_ELIGIBLE');
  if (!context.npcPlay) return reject('ENTRY_CLOSED');
  if (Object.values(replay.state.generals).some((general) => general.userId === payload.userId))
    return reject('ALREADY_HAS_GENERAL');
  if (
    Object.values(replay.state.generals).filter((general) => general.userId !== null && general.removedAt === undefined)
      .length >= HUMAN_GENERAL_LIMIT
  )
    return reject('WORLD_FULL');
  const target = replay.state.generals[payload.generalId];
  if (target?.userId != null) return reject('TAKEN');
  const revision = replay.revisions[payload.generalId];
  if (
    !availableNpc(replay.state, payload.generalId, context.tick) ||
    !Number.isSafeInteger(revision) ||
    revision! < 0 ||
    revision! >= 2_147_483_647
  )
    return reject('NOT_ELIGIBLE');
  return {
    status: 'APPLIED',
    result: {
      ...payload,
      revision: revision! + 1,
      rulerNationId: target!.officerLevel === 12 ? target!.nationId : null,
      ...(replay.policy ? { activeTick: context.tick } : {}),
    },
  };
}

export function recordedPossession(input: RecordedInput): { generalId: number; userId: string } | undefined {
  if (input.kind !== POSSESSION_KIND || input.status !== 'APPLIED') return undefined;
  validatePossessionRecord(input);
  return possessionPayloadSchema.parse(input.payload);
}
