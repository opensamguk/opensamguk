import { describe, expect, it } from 'vitest';
import {
  canReset,
  resetConfirmation,
  resetWorldStamp,
  ownResetReply,
  validResetReason,
  type ResetWorld,
  type ResetCommand,
  type ResetReply,
} from './adminResetModel';

const world: ResetWorld = {
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
describe('AC-M3-04 초기화 확인 경계', () => {
  it('정확한 공백·대소문자·Unicode를 보존하고 긴 이름도 받는다', () => {
    expect(resetConfirmation(world, world.name, '사유', true)).toBe(true);
    for (const name of [world.name.trim(), world.name.toUpperCase(), '긴 월드 이름']) {
      if (name !== world.name) expect(resetConfirmation(world, name, '사유', true)).toBe(false);
    }
    const composed = { ...world, name: 'é' };
    expect(resetConfirmation(composed, 'e\u0301', '사유', true)).toBe(false);
    const long = { ...world, name: '긴 이름'.repeat(100) };
    expect(resetConfirmation(long, long.name, '사유', true)).toBe(true);
  });
  it('일시정지·형식3와 별도 확인만 허용한다', () => {
    for (const status of ['PREOPEN', 'RUNNING', 'ENDED'] as const) expect(canReset({ ...world, status })).toBe(false);
    expect(canReset({ ...world, replayFormat: 1 })).toBe(false);
    expect(canReset(null)).toBe(false);
    expect(resetConfirmation(world, world.name, '사유', false)).toBe(false);
  });
  it('정규화한 사유1~200자와 제어문자 경계를 지킨다', () => {
    for (const value of ['', ' ', 'a'.repeat(201), '사유\n중간', '사유\u007f', '\ud800', '사유\u0000'])
      expect(validResetReason(value)).toBe(false);
    expect(validResetReason(' 사유 ')).toBe(true);
    expect(validResetReason('a'.repeat(200))).toBe(true);
  });
  it('시드는 공백·대소문자·긴 문자열을 보존하고 저장할 수 없는 문자만 거부한다', () => {
    for (const seed of ['', ' ', ' Seed ', '길다'.repeat(1000), '😀'])
      expect(resetConfirmation(world, world.name, '사유', true, seed)).toBe(true);
    for (const seed of ['a\u0000', '\ud800', '\udfff'])
      expect(resetConfirmation(world, world.name, '사유', true, seed)).toBe(false);
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
      expect(resetWorldStamp({ ...world, ...change })).not.toBe(resetWorldStamp(world));
    expect(resetWorldStamp({ ...world, heartbeat: null })).toBe(resetWorldStamp(world));
  });
  it('계정·월드·UUID·동작이 같은 응답만 받는다', () => {
    const command: ResetCommand = {
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
    const reply: ResetReply = {
      userId: 'account',
      worldId: world.id,
      idempotencyKey: 'key',
      action: 'reset',
      requestId: '1',
      plannedNewWorldId: 'new-world',
      status: 'PENDING',
      sequence: null,
      tick: null,
      result: null,
    };
    expect(ownResetReply(reply, command)).toBe(true);
    for (const change of [
      { userId: 'other' },
      { worldId: 'other' },
      { idempotencyKey: 'other' },
      { requestId: '0' },
      { plannedNewWorldId: world.id },
    ])
      expect(ownResetReply({ ...reply, ...change }, command)).toBe(false);
  });
});

const command: ResetCommand = {
  world,
  input: {
    expectedUserId: 'account',
    worldId: world.id,
    idempotencyKey: 'key',
    confirmName: world.name,
    expectedRevision: 4,
    reason: '확인 사유',
    seed: ' Exact Seed ',
  },
};
const applied: ResetReply = {
  userId: 'account',
  worldId: world.id,
  idempotencyKey: 'key',
  action: 'reset',
  requestId: '12',
  plannedNewWorldId: 'new',
  status: 'APPLIED',
  sequence: 8,
  tick: 7,
  result: {
    version: 1,
    sourceWorldId: world.id,
    newWorldId: 'new',
    effectiveSeed: ' Exact Seed ',
    before: { status: 'PAUSED', tick: 7, revision: 4 },
    after: { status: 'ENDED', tick: 7, revision: 5 },
    at: '2026-10-30T00:00:00.000Z',
    finalStateHash: 'a'.repeat(64),
    sourceInitialHash: 'a'.repeat(64),
    sourceResourceHash: 'a'.repeat(64),
    sourceSettingsHash: 'a'.repeat(64),
    newInitialHash: 'b'.repeat(64),
    newResourceHash: 'a'.repeat(64),
    newSettingsHash: 'b'.repeat(64),
    resources: [
      { kind: 'MAP', name: 'integration', version: 1, contentHash: 'a'.repeat(64) },
      { kind: 'PORTRAIT_MAP', name: '191-map', version: 1, contentHash: 'a'.repeat(64) },
      { kind: 'SCENARIO', name: 'integration191', version: 1, contentHash: 'a'.repeat(64) },
      { kind: 'STAT_RULES', name: 'five-stats', version: 1, contentHash: 'a'.repeat(64) },
      { kind: 'UNIT_SET', name: 'basic', version: 1, contentHash: 'a'.repeat(64) },
    ],
    settings: {
      name: world.name,
      scenarioKey: 'integration191',
      mapKey: 'integration',
      unitSetKey: 'basic',
      presetKey: null,
      presetHash: null,
      turnTermMinutes: 60,
      endYear: 201,
      ruleFeatures: [],
      featureDataHash: 'a'.repeat(64),
    },
  },
};
describe('AC-M3-04 실제 적용 결과와 선택 시드 결속', () => {
  it('접수와 엔진 적용을 구분하며 원본·대상·revision·tick·시드를 대조한다', () => {
    expect(ownResetReply(applied, command)).toBe(true);
    if (!applied.result || !('newWorldId' in applied.result)) throw new Error('시험 결과 준비');
    for (const change of [
      { sourceWorldId: 'other' },
      { newWorldId: 'other' },
      { effectiveSeed: 'Exact Seed' },
      { before: { ...applied.result.before, revision: 3 } },
      { after: { ...applied.result.after, tick: 6 } },
    ])
      expect(ownResetReply({ ...applied, result: { ...applied.result, ...change } }, command)).toBe(false);
    expect(ownResetReply({ ...applied, result: null }, command)).toBe(false);
  });
  it('서버 생성 시드는 새 UUID 요청 없이 실제 응답을 그대로 확인한다', () => {
    const { seed, ...withoutSeed } = command.input;
    expect(seed).toBe(' Exact Seed ');
    expect(ownResetReply(applied, { ...command, input: withoutSeed })).toBe(true);
  });
});
