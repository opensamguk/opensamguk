import { describe, expect, it } from 'vitest';
import {
  requestWorldCreateInput,
  worldCreateIntent,
  worldCreateIntentSchema,
  worldCreateStatusInput,
} from './createRequest';

const input = {
  expectedUserId: '00000000-0000-4000-8000-000000000001',
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
  name: ' 생성 월드 ',
  scenarioKey: 'integration191',
  mapKey: 'integration',
  turnTermMinutes: 60,
  endYear: 201,
};
describe('ADMIN-CREATE-B AC-M3-04 생성 요청 계약', () => {
  it('클라이언트 intent와 서버가 정할 시드·월드 UUID를 분리한다', () => {
    const parsed = requestWorldCreateInput.parse(input),
      intent = worldCreateIntent(parsed);
    expect(intent).toEqual({
      version: 1,
      name: '생성 월드',
      scenarioKey: 'integration191',
      mapKey: 'integration',
      presetKey: null,
      statRulesKey: null,
      unitSetKey: null,
      portraitMapKey: null,
      ruleFeatures: null,
      seed: null,
      turnTermMinutes: 60,
      endYear: 201,
    });
    expect(worldCreateIntentSchema.parse(intent)).toEqual(intent);
    expect(Object.hasOwn(intent, 'expectedUserId')).toBe(false);
    expect(Object.hasOwn(intent, 'idempotencyKey')).toBe(false);
    expect(Object.hasOwn(intent, 'plannedWorldId')).toBe(false);
  });
  it('명시한 기능 순서는 canonical intent에서 정렬하고 미지정과 빈 목록을 구분한다', () => {
    const a = worldCreateIntent(requestWorldCreateInput.parse({ ...input, ruleFeatures: ['policy', 'personnel'] }));
    const b = worldCreateIntent(requestWorldCreateInput.parse({ ...input, ruleFeatures: ['personnel', 'policy'] }));
    expect(a).toEqual(b);
    expect(a.ruleFeatures).toEqual(['personnel', 'policy']);
    expect(worldCreateIntent(requestWorldCreateInput.parse({ ...input, ruleFeatures: [] })).ruleFeatures).toEqual([]);
    expect(worldCreateIntent(requestWorldCreateInput.parse(input)).ruleFeatures).toBeNull();
  });
  it('긴 이름은 보존하고 프리셋 기본값의 해결은 엔진에 맡긴다', () => {
    const name = '긴 이름'.repeat(100);
    const parsed = requestWorldCreateInput.parse({
      expectedUserId: input.expectedUserId,
      idempotencyKey: input.idempotencyKey,
      name,
      presetKey: 'regular',
      endYear: null,
    });
    expect(worldCreateIntent(parsed)).toMatchObject({
      name,
      presetKey: 'regular',
      scenarioKey: null,
      mapKey: null,
      turnTermMinutes: null,
      endYear: null,
    });
  });
  it.each([
    { name: ' ' },
    { scenarioKey: '../secret' },
    { mapKey: 'integration.json' },
    { turnTermMinutes: 0 },
    { turnTermMinutes: 2_147_483_648 },
    { endYear: 10001 },
    { endYear: 1.5 },
    { seed: '' },
    { ruleFeatures: ['policy', 'policy'] },
    { ruleFeatures: ['not-a-feature'] },
    { expectedUserId: 'someone' },
    { idempotencyKey: 'reuse' },
    { actor: 'ADMIN' },
    { initial: { gold: 100 } },
    { plannedWorldId: '00000000-0000-4000-8000-000000000003' },
    { status: 'DONE' },
  ])('엄격 생성 입력은 위조·지원하지 않는 값을 거부한다 (%j)', (delta) => {
    expect(requestWorldCreateInput.safeParse({ ...input, ...delta }).success).toBe(false);
  });
  it.each(['\u0000', '\ud800', '\udfff'])('DB에 저장할 수 없는 문자열은 이름과 시드 모두 거부한다', (invalid) => {
    for (const field of ['name', 'seed']) {
      expect(requestWorldCreateInput.safeParse({ ...input, [field]: '앞' + invalid + '뒤' }).success).toBe(false);
      const intent = worldCreateIntent(requestWorldCreateInput.parse(input));
      expect(worldCreateIntentSchema.safeParse({ ...intent, [field]: '앞' + invalid + '뒤' }).success).toBe(false);
    }
  });
  it('정상 surrogate 쌍과 원본 시드는 그대로 보존한다', () => {
    const valid = { ...input, name: '월드𠀀', seed: '시드𠀀' };
    expect(worldCreateIntent(requestWorldCreateInput.parse(valid))).toMatchObject({
      name: valid.name,
      seed: valid.seed,
    });
  });
  it('프리셋 없이 필요한 키와 간격을 생략하지 않는다', () => {
    const { scenarioKey, mapKey, turnTermMinutes, ...rest } = input;
    expect(requestWorldCreateInput.safeParse(rest).success).toBe(false);
    expect(requestWorldCreateInput.safeParse({ ...rest, scenarioKey, mapKey }).success).toBe(false);
    expect(requestWorldCreateInput.safeParse({ ...rest, scenarioKey, turnTermMinutes }).success).toBe(false);
  });
  it('수동 조회는 requestId나 idempotencyKey 중 정확히 하나만 받는다', () => {
    const expectedUserId = input.expectedUserId,
      key = input.idempotencyKey;
    expect(worldCreateStatusInput.parse({ expectedUserId, requestId: key })).toEqual({
      expectedUserId,
      requestId: key,
    });
    expect(worldCreateStatusInput.parse({ expectedUserId, idempotencyKey: key })).toEqual({
      expectedUserId,
      idempotencyKey: key,
    });
    expect(worldCreateStatusInput.safeParse({ expectedUserId }).success).toBe(false);
    expect(worldCreateStatusInput.safeParse({ expectedUserId, requestId: key, idempotencyKey: key }).success).toBe(
      false,
    );
    expect(worldCreateStatusInput.safeParse({ expectedUserId, requestId: key, userId: expectedUserId }).success).toBe(
      false,
    );
  });
});
