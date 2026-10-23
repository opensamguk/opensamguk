import { describe, expect, it } from 'vitest';
import { timelapseFrameInfo } from '../visibility';

describe('T4-35 / AC-P2-17 월간 도시 소유 공개 투영', () => {
  it('U1 국가 자원과 중첩 비밀값을 버리고 도시 소유만 남긴다', () => {
    expect(
      timelapseFrameInfo({
        nations: [{ nationId: 1, gold: 100, rice: 200, power: 300 }],
        cities: [{ cityKey: 1, nationId: 1, population: 999, private: { token: 'secret' } }],
        stateHash: 'secret',
      }),
    ).toEqual({ cities: [{ cityKey: 1, nationId: 1 }] });
  });

  it('U2 도시를 cityKey 오름차순으로 정렬하고 재야 소유를 보존한다', () => {
    expect(
      timelapseFrameInfo({
        cities: [
          { cityKey: 3, nationId: null },
          { cityKey: 1, nationId: 2 },
          { cityKey: 2, nationId: 1 },
        ],
      }),
    ).toEqual({
      cities: [
        { cityKey: 1, nationId: 2 },
        { cityKey: 2, nationId: 1 },
        { cityKey: 3, nationId: null },
      ],
    });
  });

  it.each([
    {},
    { cities: [{ cityKey: 1.5, nationId: 1 }] },
    { cities: [{ cityKey: 1, nationId: '1' }] },
    { cities: [{ cityKey: 1 }] },
    null,
  ])('U3 잘못 저장된 도시 소유는 거부한다: %j', (data) => {
    expect(() => timelapseFrameInfo(data)).toThrow();
  });
});
