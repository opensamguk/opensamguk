import { expect, it } from 'vitest';
import type { RecordedInput, ReplayState } from '../replay';
import {
  ADMIN_RESET_KIND,
  requestWorldResetInput,
  adminResetIntent,
  adminResetPayloadSchema,
  adminResetAppliedSchema,
  adminResetRejectMessages,
  validateAdminResetRecord,
  applyAdminResetRecord,
} from './reset';
const source = '00000000-0000-4000-8000-000000000001',
  target = '00000000-0000-4000-8000-000000000002',
  user = '00000000-0000-4000-8000-000000000003';
function input() {
  return {
    expectedUserId: user,
    worldId: source,
    idempotencyKey: target,
    confirmName: ' 원본 이름 ',
    expectedRevision: 2,
    reason: ' 확인 ',
    seed: ' 새 시드 ',
  };
}
function record(): RecordedInput {
  return {
    sequence: 1,
    tick: 4,
    generalId: null,
    kind: ADMIN_RESET_KIND,
    status: 'APPLIED',
    payload: {
      version: 1,
      sourceWorldId: source,
      plannedNewWorldId: target,
      effectiveSeed: ' 새 시드 ',
      intent: adminResetIntent(requestWorldResetInput.parse(input())),
    },
    result: {
      version: 1,
      sourceWorldId: source,
      newWorldId: target,
      effectiveSeed: ' 새 시드 ',
      before: { status: 'PAUSED', tick: 4, revision: 2 },
      after: { status: 'ENDED', tick: 4, revision: 3 },
      at: '2026-10-29T00:00:00.000Z',
      finalStateHash: 'a'.repeat(64),
      sourceInitialHash: 'b'.repeat(64),
      sourceResourceHash: 'c'.repeat(64),
      sourceSettingsHash: 'd'.repeat(64),
      newInitialHash: 'e'.repeat(64),
      newResourceHash: 'c'.repeat(64),
      newSettingsHash: 'f'.repeat(64),
      resources: ['MAP', 'PORTRAIT_MAP', 'SCENARIO', 'STAT_RULES', 'UNIT_SET'].map((kind) => ({
        kind,
        name: kind === 'MAP' ? 'map' : kind === 'SCENARIO' ? 'scenario' : kind === 'UNIT_SET' ? 'units' : 'selected',
        version: 1,
        contentHash: 'a'.repeat(64),
      })),
      settings: {
        name: ' 원본 이름 ',
        scenarioKey: 'scenario',
        mapKey: 'map',
        unitSetKey: 'units',
        presetKey: null,
        presetHash: null,
        turnTermMinutes: 30,
        endYear: null,
        ruleFeatures: [],
        featureDataHash: 'a'.repeat(64),
      },
    },
  };
}
it('이름과 시드는 원문 보존하고 사유만 기존 시계 계약으로 정리한다', () => {
  const parsed = requestWorldResetInput.parse(input());
  expect(parsed.confirmName).toBe(' 원본 이름 ');
  expect(parsed.seed).toBe(' 새 시드 ');
  expect(adminResetIntent(parsed)).toEqual({
    confirmName: ' 원본 이름 ',
    expectedRevision: 2,
    reason: '확인',
    requestedSeed: ' 새 시드 ',
  });
  expect(() => validateAdminResetRecord(record(), source)).not.toThrow();
});
it('시드 생략은 canonical null이고 기존 긴 이름도 그대로 유지한다', () => {
  const value = { ...input(), confirmName: '기존 긴 이름'.repeat(100) };
  delete (value as { seed?: string }).seed;
  expect(adminResetIntent(requestWorldResetInput.parse(value))).toMatchObject({
    confirmName: value.confirmName,
    requestedSeed: null,
  });
});
it.each(['\u0000', '\ud800', '\udfff', ''])('저장 불가능한 이름·시드 %j를 거부한다', (value) => {
  expect(requestWorldResetInput.safeParse({ ...input(), confirmName: value }).success).toBe(false);
  expect(requestWorldResetInput.safeParse({ ...input(), seed: value }).success).toBe(false);
});
it.each([-1, 2147483647, 0.5, NaN, Infinity])('revision 경계 %j를 거부한다', (value) =>
  expect(requestWorldResetInput.safeParse({ ...input(), expectedRevision: value }).success).toBe(false),
);
it('추가 사용자·계획 UUID·고정 시드 필드는 client가 지정하지 못한다', () => {
  for (const extra of [{ userId: user }, { plannedNewWorldId: target }, { effectiveSeed: 'forged' }, { version: 1 }])
    expect(requestWorldResetInput.safeParse({ ...input(), ...extra }).success).toBe(false);
});
it('요청의 원본·새 UUID·지정 시드·canonical 사유 결합을 거부한다', () => {
  const p = record().payload as Record<string, unknown>;
  for (const change of [
    { plannedNewWorldId: source },
    { effectiveSeed: 'other' },
    { sourceWorldId: 'invalid' },
    { extra: true },
    { intent: { ...(p.intent as object), reason: ' 확인 ' } },
  ])
    expect(adminResetPayloadSchema.safeParse({ ...p, ...change }).success).toBe(false);
});
it('상태·게임·시드·예약을 바꾸지 않는 identity replay 계약이다', () => {
  const replay = {
      state: { seed: 'original' },
      turns: { 1: Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {} })) },
      revisions: { 1: 2 },
      monthlyTick: 0,
    } as unknown as ReplayState,
    before = structuredClone(replay);
  expect(applyAdminResetRecord(replay, record())).toBe(replay);
  expect(replay).toEqual(before);
});
it.each(Object.entries(adminResetRejectMessages))('고정 기각 %s만 허용한다', (code, message) => {
  expect(() => validateAdminResetRecord({ ...record(), status: 'REJECTED', result: { code, message } })).not.toThrow();
  expect(() =>
    validateAdminResetRecord({ ...record(), status: 'REJECTED', result: { code, message: 'private' } }),
  ).toThrow();
});
it('record7keys와 숫자·kind·null·완료 상태를 엄격히 검사한다', () => {
  for (const delta of [
    { extra: true },
    { kind: 'admin.world.end' },
    { generalId: 1 },
    { sequence: 0 },
    { sequence: 2147483648 },
    { tick: null },
    { tick: -1 },
    { status: 'PENDING' },
    { payload: null },
  ])
    expect(() => validateAdminResetRecord({ ...record(), ...delta } as RecordedInput)).toThrow();
});
it('적용 결과의 양쪽UUID·시드·revision·tick·설정·manifest 변조를 거부한다', () => {
  const r = record(),
    result = r.result as Record<string, unknown>;
  for (const delta of [
    { sourceWorldId: target },
    { newWorldId: source },
    { newWorldId: user },
    { effectiveSeed: 'other' },
    { newResourceHash: 'b'.repeat(64) },
    { extra: true },
    { before: { status: 'PAUSED', tick: 4, revision: 3 } },
    { after: { status: 'ENDED', tick: 5, revision: 3 } },
    { newInitialHash: 'invalid' },
    { settings: { ...(result.settings as object), name: 'other' } },
  ])
    expect(() => validateAdminResetRecord({ ...r, result: { ...result, ...delta } })).toThrow();
  const resources = result.resources as Record<string, unknown>[];
  for (const values of [
    resources.slice(1),
    [...resources].reverse(),
    resources.map((r, index) => (index === 1 ? resources[0] : r)),
    resources.map((r, index) => (index === 0 ? { ...r, version: 2 } : r)),
    resources.map((r, index) => (index === 0 ? { ...r, name: 'other' } : r)),
  ])
    expect(adminResetAppliedSchema.safeParse({ ...result, resources: values }).success).toBe(false);
  expect(() => validateAdminResetRecord(record(), target)).toThrow();
});
