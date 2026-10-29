import { describe, expect, it } from 'vitest';
import {
  canEnd,
  endConfirmation,
  endWorldStamp,
  ownEndReply,
  validEndReason,
  type EndWorld,
  type EndCommand,
  type EndReply,
} from './adminEndModel';

const world: EndWorld = {
  id: 'world',
  name: ' 긴 월드 이름 ',
  status: 'PAUSED',
  clockRevision: 4,
  replayFormat: 3,
  scenarioKey: 'integration191',
  presetKey: null,
  turnTermMinutes: 60,
  humanGenerals: 1,
  heartbeat: null,
};
describe('AC-M3-04 종료 확인 경계', () => {
  it('정확한 공백·대소문자·Unicode를 보존하고 긴 이름도 받는다', () => {
    expect(endConfirmation(world, world.name, '사유', true)).toBe(true);
    for (const name of [world.name.trim(), world.name.toUpperCase(), '긴 월드 이름']) {
      if (name !== world.name) expect(endConfirmation(world, name, '사유', true)).toBe(false);
    }
    const composed = { ...world, name: 'é' };
    expect(endConfirmation(composed, 'e\u0301', '사유', true)).toBe(false);
    const long = { ...world, name: '긴 이름'.repeat(100) };
    expect(endConfirmation(long, long.name, '사유', true)).toBe(true);
  });
  it('일시정지·형식3와 별도 확인만 허용한다', () => {
    for (const status of ['PREOPEN', 'RUNNING', 'ENDED'] as const) expect(canEnd({ ...world, status })).toBe(false);
    expect(canEnd({ ...world, replayFormat: 1 })).toBe(false);
    expect(canEnd(null)).toBe(false);
    expect(endConfirmation(world, world.name, '사유', false)).toBe(false);
  });
  it('정규화한 사유1~200자와 제어문자 경계를 지킨다', () => {
    for (const value of ['', ' ', 'a'.repeat(201), '사유\n중간', '사유\u007f'])
      expect(validEndReason(value)).toBe(false);
    expect(validEndReason(' 사유 ')).toBe(true);
    expect(validEndReason('a'.repeat(200))).toBe(true);
  });
  it('조회에서 바뀐 모든 확인 항목을 구분한다', () => {
    for (const change of [
      { id: 'other' },
      { name: 'other' },
      { status: 'RUNNING' as const },
      { clockRevision: 5 },
      { replayFormat: 1 },
      { humanGenerals: 2 },
    ])
      expect(endWorldStamp({ ...world, ...change })).not.toBe(endWorldStamp(world));
    expect(endWorldStamp({ ...world, heartbeat: null })).toBe(endWorldStamp(world));
  });
  it('계정·월드·UUID·동작이 같은 응답만 받는다', () => {
    const command: EndCommand = {
      world,
      input: {
        expectedUserId: 'account',
        worldId: world.id,
        idempotencyKey: 'key',
        confirmName: world.name,
        expectedRevision: 4,
        reason: '사유',
      },
    };
    const reply: EndReply = {
      userId: 'account',
      worldId: world.id,
      idempotencyKey: 'key',
      action: 'end',
      requestId: '1',
      status: 'PENDING',
      sequence: null,
      tick: null,
      result: null,
    };
    expect(ownEndReply(reply, command)).toBe(true);
    for (const change of [{ userId: 'other' }, { worldId: 'other' }, { idempotencyKey: 'other' }])
      expect(ownEndReply({ ...reply, ...change }, command)).toBe(false);
  });
});
