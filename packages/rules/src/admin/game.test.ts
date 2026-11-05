import { expect, it } from 'vitest';
import { adminGamePayloadSchema } from './game';

const payload = (action: unknown) => ({ version: 1, reason: '운영 조치 검증', action });
it('AC-INT-23 조치와 각 변경 칸은 서버 행위자·불명 필드와 빈 조정을 거부한다', () => {
  const action = { kind: 'admin.general.adjust', generalId: 1, changes: { gold: { expected: 10, value: 20 } } };
  expect(adminGamePayloadSchema.parse(payload(action))).toEqual(payload(action));
  for (const value of [
    { ...payload(action), actorId: '다른 사용자' },
    payload({ ...action, userId: '다른 사용자' }),
    payload({ ...action, changes: {} }),
    payload({ ...action, changes: { leadership: { expected: 10, value: 20 } } }),
    payload({ ...action, changes: { gold: { expected: 10, value: 20, delta: 10 } } }),
    payload({ ...action, changes: { gold: { value: 20 } } }),
    { ...payload(action), reason: '\n' },
    payload({ kind: 'admin.general.remove', generalId: 1 }),
  ])
    expect(adminGamePayloadSchema.safeParse(value).success).toBe(false);
});
it('AC-INT-23 수량·시나리오 상한 이전의 고정 범위와 민심·기술 소수를 구분한다', () => {
  const general = (value: number) =>
    payload({
      kind: 'admin.general.adjust',
      generalId: 1,
      changes: { train: { expected: 0, value } },
    });
  for (const value of [-1, 0.5, 101, NaN, Infinity])
    expect(adminGamePayloadSchema.safeParse(general(value)).success).toBe(false);
  expect(adminGamePayloadSchema.safeParse(general(100)).success).toBe(true);
  expect(
    adminGamePayloadSchema.safeParse(
      payload({
        kind: 'admin.city.adjust',
        cityKey: 1,
        changes: { trust: { expected: 50.2, value: 50.5 } },
      }),
    ).success,
  ).toBe(true);
  expect(
    adminGamePayloadSchema.safeParse(
      payload({
        kind: 'admin.nation.adjust',
        nationId: 1,
        changes: { tech: { expected: 11999.5, value: 12000.1 } },
      }),
    ).success,
  ).toBe(false);
});
it('AC-INT-23 장수 이름은 생성 규칙의 정규화·문자·길이를 재사용한다', () => {
  const action = { kind: 'admin.general.rename', generalId: 1, name: '  가  ' };
  expect(adminGamePayloadSchema.parse(payload(action)).action).toMatchObject({ name: '가' });
  for (const name of ['일곱글자이름임', '잘못된 이름', '<장수>'])
    expect(adminGamePayloadSchema.safeParse(payload({ ...action, name })).success).toBe(false);
});
