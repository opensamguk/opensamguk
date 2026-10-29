import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

export type EndWorld = inferRouterOutputs<AppRouter>['admin']['world']['list'][number];
export type EndInput = inferRouterInputs<AppRouter>['admin']['world']['requestEnd'];
export type EndReply = inferRouterOutputs<AppRouter>['admin']['world']['endRequest'];
export type EndCommand = Readonly<{ input: Readonly<EndInput>; world: Readonly<EndWorld> }>;

export function endWorldStamp(world: EndWorld) {
  return JSON.stringify([
    world.id,
    world.name,
    world.status,
    world.clockRevision,
    world.replayFormat,
    world.humanGenerals,
    'end',
  ]);
}
export function canEnd(world: EndWorld | null | undefined) {
  return world?.status === 'PAUSED' && world.replayFormat === 3;
}
export function validEndReason(value: string) {
  const reason = value.trim();
  return (
    reason.length > 0 &&
    reason.length <= 200 &&
    [...reason].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}
export function endConfirmation(world: EndWorld, name: string, reason: string, checked: boolean) {
  return canEnd(world) && name === world.name && validEndReason(reason) && checked;
}
export function ownEndReply(reply: EndReply, command: EndCommand) {
  return (
    reply.action === 'end' &&
    reply.userId === command.input.expectedUserId &&
    reply.worldId === command.input.worldId &&
    reply.idempotencyKey === command.input.idempotencyKey
  );
}
// 서버의 고정 code만 표시한다. 내부 오류나 임의 message를 화면에 옮기지 않는다.
export const endRejections = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  WORLD_STATE_CHANGED: '월드 상태가 바뀌어 종료하지 않았습니다.',
  WORLD_NAME_CHANGED: '확인한 월드 이름이 달라 종료하지 않았습니다.',
  WORLD_REVISION_CHANGED: '월드 시계가 바뀌어 종료하지 않았습니다.',
  UNSUPPORTED_FORMAT: '이 월드의 재생 형식에서는 사용할 수 없습니다.',
  WORLD_RESULT_EXISTS: '종료 기록이 있어 요청을 적용하지 않았습니다.',
} as const;
