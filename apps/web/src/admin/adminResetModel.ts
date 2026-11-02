import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

export type ResetWorld = inferRouterOutputs<AppRouter>['admin']['world']['list'][number];
export type ResetInput = inferRouterInputs<AppRouter>['admin']['world']['requestReset'];
export type ResetReply = inferRouterOutputs<AppRouter>['admin']['world']['resetRequest'];
export type ResetCommand = Readonly<{ input: Readonly<ResetInput>; world: Readonly<ResetWorld> }>;

export function resetWorldStamp(world: ResetWorld) {
  return JSON.stringify([
    world.id,
    world.name,
    world.status,
    world.clockRevision,
    world.replayFormat,
    world.humanGenerals,
    'reset',
  ]);
}
export function canReset(world: ResetWorld | null | undefined) {
  return world?.status === 'PAUSED' && world.replayFormat === 3;
}
export function validResetReason(value: string) {
  const reason = value.trim();
  return (
    reason.length > 0 &&
    reason.length <= 200 &&
    validResetSeed(reason) &&
    [...reason].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}
export function validResetSeed(seed: string) {
  return (
    !seed.includes('\u0000') &&
    Array.from(seed).every((c) => c.length === 2 || c.charCodeAt(0) < 0xd800 || c.charCodeAt(0) > 0xdfff)
  );
}
export function resetConfirmation(world: ResetWorld, name: string, reason: string, checked: boolean, seed = '') {
  return (
    canReset(world) &&
    validResetSeed(name) &&
    name === world.name &&
    validResetReason(reason) &&
    validResetSeed(seed) &&
    checked
  );
}
export function ownResetReply(reply: ResetReply, command: ResetCommand) {
  return (
    reply.action === 'reset' &&
    reply.userId === command.input.expectedUserId &&
    reply.worldId === command.input.worldId &&
    reply.idempotencyKey === command.input.idempotencyKey &&
    /^[1-9][0-9]*$/.test(reply.requestId) &&
    reply.plannedNewWorldId !== command.input.worldId &&
    (reply.status !== 'APPLIED' ||
      (reply.result !== null &&
        'newWorldId' in reply.result &&
        reply.result.newWorldId === reply.plannedNewWorldId &&
        reply.result.sourceWorldId === command.input.worldId &&
        reply.result.before.revision === command.input.expectedRevision &&
        reply.result.after.status === 'ENDED' &&
        reply.result.after.revision === command.input.expectedRevision + 1 &&
        reply.result.before.tick === reply.tick &&
        reply.result.after.tick === reply.tick &&
        (command.input.seed === undefined || reply.result.effectiveSeed === command.input.seed)))
  );
}
// 서버의 고정 code만 표시한다. 내부 오류나 임의 message를 화면에 옮기지 않는다.
export const resetRejections = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  WORLD_STATE_CHANGED: '월드 상태가 바뀌어 초기화하지 않았습니다.',
  WORLD_NAME_CHANGED: '확인한 월드 이름이 달라 초기화하지 않았습니다.',
  WORLD_REVISION_CHANGED: '월드 시계가 바뀌어 초기화하지 않았습니다.',
  UNSUPPORTED_FORMAT: '이 월드의 재생 형식에서는 사용할 수 없습니다.',
  WORLD_RESULT_EXISTS: '종료 기록이 있어 요청을 적용하지 않았습니다.',
  RESOURCE_INVALID: '원본 생성 자료를 확인하지 못해 초기화하지 않았습니다.',
  TARGET_EXISTS: '새 월드 번호가 이미 사용돼 초기화하지 않았습니다.',
} as const;
