import { describe, expect, it } from 'vitest';
import {
  CreateDraftError,
  createFailurePhase,
  createPointer,
  createRejections,
  failureMessage,
  freezeCreation,
  initialCreateProfile,
  lockedFields,
  mergeVersionPages,
  ownCreateReply,
  resourceFieldList,
  reviewCreation,
  storedText,
  versionLabel,
  type CreateReply,
  type VersionItem,
  type VersionList,
  type VersionLists,
} from './adminCreateModel';
import { draft, options, expandedProfile, requestId, requestKey, viewerId, worldId } from './test/createFixture';
describe('AC-M3-04 생성 요청 확인·복구 경계', () => {
  it('자동 시드와 명시5자원·현재10기능을 고정하고 입력·키를 변경하지 않는다', () => {
    const original = JSON.stringify([options, draft]);
    const review = reviewCreation(options, draft, viewerId, 'one-seed');
    const command = freezeCreation(review, requestKey);
    expect(command.input).toMatchObject({
      expectedUserId: viewerId,
      name: '새 월드',
      seed: 'one-seed',
      idempotencyKey: requestKey,
      scenarioKey: 'integration191',
      mapKey: 'integration',
      statRulesKey: 'five-stats',
      portraitMapKey: '191-map',
      unitSetKey: 'basic',
      endYear: 201,
      turnTermMinutes: 60,
    });
    expect(command.input.ruleFeatures).toContain('city-resources-v1');
    expect(command.input.ruleFeatures).not.toContain('treaty-trade');
    expect(command.input).not.toHaveProperty('featureProfileKey');
    expect(Object.isFrozen(command.input)).toBe(true);
    expect(Object.isFrozen(command.input.ruleFeatures)).toBe(true);
    expect(JSON.stringify([options, draft])).toBe(original);
  });
  it('AC-P2-30~34 확장판의 키·15기능을 고정하고 조회 전용 해시는 전송하지 않는다', () => {
    const value = { ...options, profiles: [expandedProfile] };
    const review = reviewCreation(value, { ...draft, profileId: expandedProfile.id, endYear: '231' }, viewerId, 'seed');
    const input = freezeCreation(review, requestKey).input;
    expect(review.profileLabel).toBe(expandedProfile.label);
    expect(input.featureProfileKey).toBe('expanded-191-v3');
    expect(input.ruleFeatures).toEqual(expandedProfile.ruleFeatures);
    expect(input.ruleFeatures).toHaveLength(15);
    expect(input.endYear).toBe(231);
    for (const key of ['featureProfileHash', 'expandedProfiles', 'profileId']) expect(input).not.toHaveProperty(key);
  });
  it('직접 시드의 공백·Unicode와 endYear null을 그대로 보존한다', () => {
    const review = reviewCreation(
      options,
      { ...draft, endMode: 'none', seedMode: 'custom', seed: ' e\u0301 ' },
      viewerId,
      'ignored',
    );
    expect(review.input.seed).toBe(' e\u0301 ');
    expect(review.input.endYear).toBeNull();
  });
  it('현재 계정·현재 프리셋·지원 프로필이 아니면 생성하지 않는다', () => {
    for (const invalid of [
      { ...options, userId: worldId },
      { ...options, profiles: [] },
    ])
      expect(() => reviewCreation(invalid, draft, viewerId, 'seed')).toThrow();
    expect(() => reviewCreation(options, { ...draft, presetKey: 'not-current' }, viewerId, 'seed')).toThrow();
    for (const profileId of ['', 'missing', 'san10-empty'])
      expect(() => reviewCreation(options, { ...draft, profileId }, viewerId, 'seed')).toThrow();
  });
  it('기본 프로필이 없으면 직접 선택하며 통합판으로 자동 대체하지 않는다', () => {
    expect(initialCreateProfile(options)).toBe('');
    expect(initialCreateProfile(options, 'integration-v01')).toBe('integration-v01');
    expect(initialCreateProfile({ ...options, profiles: [] })).toBe('');
    const review = reviewCreation(options, draft, viewerId, 'seed');
    expect(review.profileId).toBe(draft.profileId);
    expect(review.startYear).toBe(191);
    expect(review.counts?.nations).toBe(21);
    expect(Object.isFrozen(review.counts)).toBe(true);
    expect(Object.isFrozen(review.presetDescriptions)).toBe(true);
  });
  it('숫자의 지수·소수·범위 및 저장할 수 없는 문자열을 차단한다', () => {
    for (const turnTerm of ['0', '1.5', '1e2', '2147483648'])
      expect(() => reviewCreation(options, { ...draft, turnTerm }, viewerId, 'seed')).toThrow();
    for (const endYear of ['190', '10001', '2e2'])
      expect(() => reviewCreation(options, { ...draft, endYear }, viewerId, 'seed')).toThrow();
    for (const seed of ['', '\u0000', '\ud800']) expect(storedText(seed)).toBe(false);
    expect(storedText('한글🙂')).toBe(true);
  });
  it('완료 응답은 같은 계정·요청과 유효 월드만 받는다', () => {
    const pointer = { version: 1 as const, viewerId, idempotencyKey: requestKey, requestId };
    const reply: CreateReply = {
      userId: viewerId,
      idempotencyKey: requestKey,
      requestId,
      status: 'DONE',
      worldId,
      error: null,
    };
    expect(ownCreateReply(reply, pointer)).toBe(true);
    for (const patch of [
      { userId: worldId },
      { idempotencyKey: worldId },
      { requestId: worldId },
      { worldId: null },
      { status: 'PENDING' as const },
    ])
      expect(ownCreateReply({ ...reply, ...patch }, pointer)).toBe(false);
    expect(
      ownCreateReply(
        { ...reply, status: 'FAILED', worldId: null, error: { code: 'RESOURCE_INVALID', message: 'untrusted' } },
        pointer,
      ),
    ).toBe(true);
    expect(
      ownCreateReply(
        { ...reply, status: 'FAILED', worldId: null, error: { code: 'INTERNAL_UNKNOWN', message: 'untrusted' } },
        pointer,
      ),
    ).toBe(false);
  });
  it('최소 추적 포인터는 본인 UUID와 알려진 필드만 받는다', () => {
    const pointer = { version: 1, viewerId, idempotencyKey: requestKey };
    expect(createPointer(pointer, viewerId)).toEqual(pointer);
    for (const value of [
      null,
      [],
      { ...pointer, viewerId: worldId },
      { ...pointer, idempotencyKey: 'bad' },
      { ...pointer, seed: 'must-not-store' },
      { ...pointer, requestId: 'bad' },
    ])
      expect(createPointer(value, viewerId)).toBeNull();
  });
  it('미접수는 최초400만 확정하며 충돌·404·유실을 새 요청 허용으로 삼지 않는다', () => {
    expect(createFailurePhase('BAD_REQUEST', true)).toBe('notAccepted');
    expect(createFailurePhase('BAD_REQUEST', false)).toBe('unknown');
    for (const code of ['CONFLICT', 'NOT_FOUND', 'INTERNAL_SERVER_ERROR', undefined])
      expect(createFailurePhase(code, true)).toBe('unknown');
    expect(createFailurePhase('TOO_MANY_REQUESTS', true)).toBe('limited');
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN']) expect(createFailurePhase(code, false)).toBe('denied');
  });
});

// T4-90: 다섯 칸의 판 고르기. 기대값은 T4-79 260~266행 계약과 apps/engine/src/admin/createRequests.ts의 묶음 검사다.
const item = (name: string, version: number): VersionItem => ({
  key: version === 1 ? name : `${name}@${version}`,
  name,
  version,
  contentHash: `hash-${name}-${version}`,
});
const ready = (...items: VersionItem[]): VersionList => ({ status: 'ready', items });
function lists(over: Partial<VersionLists> = {}): VersionLists {
  const base = options.profiles[0]!;
  if (!base.available) throw new Error('available fixture required');
  const s = base.selection;
  return {
    scenarioKey: ready(item(s.scenarioKey, 1), item('1030', 2)),
    mapKey: ready(item(s.mapKey, 1), item('che', 2)),
    unitSetKey: ready(item(s.unitSetKey, 1)),
    statRulesKey: ready(item(s.statRulesKey, 1)),
    portraitMapKey: ready(item(s.portraitMapKey, 1)),
    ...over,
  };
}
describe('T4-90 판 고르기 모델', () => {
  it('기본 묶음은 칸을 건드리지 않으면 입력이 이전과 같고 목록 없이도 만든다', () => {
    const before = reviewCreation(options, draft, viewerId, 'seed').input;
    const after = reviewCreation(options, { ...draft, resources: {} }, viewerId, 'seed', lists()).input;
    expect(after).toEqual(before);
    expect(after.ruleFeatures).toHaveLength(10);
    const frozen = freezeCreation(reviewCreation(options, draft, viewerId, 'seed'), requestKey).input;
    expect(frozen).toEqual({ ...before, idempotencyKey: requestKey });
    const review = reviewCreation(options, draft, viewerId, 'seed');
    expect([review.startYear, review.changed]).toEqual([191, []]);
  });
  it('고른 키가 정규형 그대로 들어가고 @1을 붙이지 않으며 기본과 같은 값은 바꾼 칸이 아니다', () => {
    const picked = { ...draft, resources: { scenarioKey: '1030@2', mapKey: 'che@2', unitSetKey: 'basic' } };
    const review = reviewCreation(options, picked, viewerId, 'seed', lists());
    expect(review.input).toMatchObject({ scenarioKey: '1030@2', mapKey: 'che@2', unitSetKey: 'basic' });
    expect(review.input.statRulesKey).toBe('five-stats');
    expect(review.changed).toEqual(['scenarioKey', 'mapKey']);
    expect(JSON.stringify(review.input)).not.toContain('@1');
  });
  it('칸을 바꾸면 ruleFeatures를 생략하고 얼리는 단계에서도 빈 배열로 바꾸지 않는다', () => {
    const review = reviewCreation(options, { ...draft, resources: { mapKey: 'che@2' } }, viewerId, 'seed', lists());
    expect(review.input).not.toHaveProperty('ruleFeatures');
    const input = freezeCreation(review, requestKey).input;
    expect(input).not.toHaveProperty('ruleFeatures');
    expect(Object.keys(input)).not.toContain('ruleFeatures');
    expect(JSON.stringify(input)).not.toContain('ruleFeatures');
  });
  it('바뀐 조합에는 기본 프로필의 연도·수치를 싣지 않고 종료 연도 하한은 서버에 맡긴다', () => {
    const review = reviewCreation(
      options,
      { ...draft, endYear: '150', resources: { scenarioKey: '1030@2' } },
      viewerId,
      'seed',
      lists(),
    );
    expect([review.startYear, review.counts]).toEqual([null, null]);
    expect(review.input.endYear).toBe(150);
    expect(() => reviewCreation(options, { ...draft, endYear: '150' }, viewerId, 'seed')).toThrow();
  });
  it('게시 목록에 없거나 읽지 못했거나 읽는 중이면 바꾼 칸을 막는다', () => {
    const picked = { ...draft, resources: { scenarioKey: '1030@3' } };
    for (const value of [
      lists(),
      lists({ scenarioKey: { status: 'error' } }),
      lists({ scenarioKey: { status: 'loading' } }),
      lists({ scenarioKey: ready() }),
    ])
      expect(() => reviewCreation(options, picked, viewerId, 'seed', value)).toThrow(/게시 목록에 없습니다: 1030@3/);
    expect(() => reviewCreation(options, picked, viewerId, 'seed')).toThrow(CreateDraftError);
    // 기본 키는 목록이 비었거나 오류여도 막지 않는다(서버가 이미 게시를 확인한 프로필 값).
    const empty = lists({ scenarioKey: ready(), mapKey: { status: 'error' } });
    expect(() => reviewCreation(options, draft, viewerId, 'seed', empty)).not.toThrow();
  });
  it('쪽을 합칠 때 키 중복을 버리고 name, version 순으로 정렬한다', () => {
    const merged = mergeVersionPages([
      [item('che', 10), item('san10', 2)],
      [item('che', 2), item('che', 10), item('1030', 1), item('che', 1)],
      [],
    ]);
    expect(merged.map((entry) => entry.key)).toEqual(['1030', 'che', 'che@2', 'che@10', 'san10@2']);
    expect(merged.map(versionLabel)).toEqual(['1030', 'che', 'che@2', 'che@10', 'san10@2']);
  });
  it('확장 묶음의 잠금 범위는 서버 묶음과 같다: v3(형식 2)는 시나리오·지도, 나머지는 다섯 칸', () => {
    expect(lockedFields({})).toEqual([]);
    expect(lockedFields({ featureProfileKey: 'expanded-191-v3' })).toEqual(['scenarioKey', 'mapKey']);
    for (const key of ['expanded-191-v4', 'expanded-191-v5', 'expanded-191-v6', 'future-profile'])
      expect(lockedFields({ featureProfileKey: key })).toEqual(resourceFieldList);
    // 잠긴 칸에 남은 값은 바뀐 칸으로 세지 않고 프로필 값과 기능 목록을 그대로 보낸다.
    const stale = { scenarioKey: '1030@2', unitSetKey: 'x' };
    for (const [profile, changed] of [
      [expandedProfile, ['unitSetKey']],
      [{ ...expandedProfile, featureProfileKey: 'expanded-191-v4' }, []],
    ] as const) {
      const value = { ...options, profiles: [profile] };
      const base = { ...draft, profileId: profile.id, endYear: '231' };
      if (changed.length === 0) {
        const review = reviewCreation(value, { ...base, resources: stale }, viewerId, 'seed', lists());
        expect(review.input).toMatchObject({ scenarioKey: 'integration191', unitSetKey: 'basic' });
        expect(review.input.ruleFeatures).toEqual(profile.ruleFeatures);
        expect(review.changed).toEqual([]);
      } else {
        // 형식 2인 v3는 병종을 서버가 검사하지 않으므로 게시 목록의 판을 고를 수 있다. 그래도 ruleFeatures는 프로필 목록을 그대로 보낸다.
        const review = reviewCreation(
          value,
          { ...base, resources: { ...stale, unitSetKey: 'basic@2' } },
          viewerId,
          'seed',
          lists({ unitSetKey: ready(item('basic', 1), item('basic', 2)) }),
        );
        expect(review.input).toMatchObject({ scenarioKey: 'integration191', unitSetKey: 'basic@2' });
        expect(review.input).toHaveProperty('featureProfileKey', 'expanded-191-v3');
        expect(freezeCreation(review, requestKey).input.ruleFeatures).toEqual(profile.ruleFeatures);
        expect(review.input.ruleFeatures).toEqual(profile.ruleFeatures);
        expect(review.changed).toEqual(changed);
      }
    }
  });
  it('FAILED는 서버 문구를 우선하고 비었을 때만 고정 문구를 쓴다', () => {
    expect(failureMessage({ code: 'INPUT_INVALID', message: '시나리오와 지도의 짝이 맞지 않습니다.' })).toBe(
      '시나리오와 지도의 짝이 맞지 않습니다.',
    );
    expect(failureMessage({ code: 'RESOURCE_INVALID', message: '   ' })).toBe(createRejections.RESOURCE_INVALID);
    expect(failureMessage({ code: 'ADMIN_REQUIRED', message: '' })).toBe('관리자 권한이 없습니다.');
  });
});
