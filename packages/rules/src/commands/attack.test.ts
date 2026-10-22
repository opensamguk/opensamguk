import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import type { WorldState } from '../model/world';
import { applyEffects } from './effects';
import { attack } from './attack';
import { runCommand } from './registry';
import { verifySuccess, verifyFailure } from './contracts';

describe('attack', () => {
  it('성공', () => verifySuccess('attack'));
  it('실패', () => verifyFailure('attack'));
});

describe('T4-33 출병 추출 전 골든', () => {
  // main 5432ee83의 원 출병 구현에서 결과 전체와 RNG 다음값을 실측했다.
  const cases: [string, (state: WorldState) => void][] = [
    ['수비 둘과 성벽, 마지막 도시 멸망', () => {}],
    [
      '동률 수비의 ID 순서',
      (s) => {
        s.generals[3]!.crew = 20;
      },
    ],
    [
      '열 페이즈 뒤 양쪽 생존',
      (s) => {
        s.generals[2]!.crew = 10000;
        s.generals[3]!.crew = 0;
      },
    ],
    [
      '공격군 기아로 전투 전 사기 소진',
      (s) => {
        s.generals[1]!.rice = 0;
        s.generals[1]!.atmos = 20;
      },
    ],
    [
      '수비군 기아로 전투 전 사기 소진',
      (s) => {
        s.generals[2]!.rice = 0;
        s.generals[2]!.atmos = 20;
      },
    ],
    [
      '병력 하나씩 동시 전멸',
      (s) => {
        s.generals[1]!.crew = 1;
        s.generals[2]!.crew = 1;
        s.generals[3]!.crew = 0;
      },
    ],
    [
      '양쪽 사기 동시 소진',
      (s) => {
        s.generals[1]!.atmos = 50;
        s.generals[2]!.crew = 10000;
        s.generals[2]!.atmos = 50;
        s.generals[3]!.crew = 0;
      },
    ],
    [
      '수비 없는 성벽과 방어 보정',
      (s) => {
        s.generals[2]!.crew = 0;
        s.generals[3]!.crew = 0;
        s.cities[2]!.wall = 1000;
        s.cities[2]!.defence = 200;
        s.generals[1]!.crew = 2000;
      },
    ],
    [
      '병종 상성과 양국 기술',
      (s) => {
        s.generals[1]!.crew = 2000;
        s.generals[1]!.crewType = 1300;
        s.generals[2]!.crew = 2000;
        s.generals[2]!.crewType = 1200;
        s.generals[3]!.train = 0;
        s.nations[1]!.tech = 12000;
        s.nations[2]!.tech = 3000;
      },
    ],
    [
      '수비와 성벽이 없는 도시',
      (s) => {
        s.generals[2]!.crew = 0;
        s.generals[3]!.crew = 0;
        s.cities[2]!.wall = 0;
      },
    ],
    [
      '병종 누락 사전 거부',
      (s) => {
        s.generals[2]!.crewType = 9999;
      },
    ],
    [
      '교전 아닌 국가 거부',
      (s) => {
        s.diplomacies = [];
      },
    ],
    [
      '수도 함락과 같은 인구 도시 천도',
      (s) => {
        s.cities[3]!.nationId = 2;
        s.cities[4]!.nationId = 2;
      },
    ],
    [
      '훈련 미달과 미등장 수비 제외',
      (s) => {
        s.generals[2]!.train = 0;
        s.generals[3]!.activeFromYear = 200;
      },
    ],
  ];

  it('14개 출병의 전체 결과와 난수 소비를 보존한다', async () => {
    const actual = await Promise.all(
      cases.map(async ([name, setup]) => {
        const state = commandWorld();
        setup(state);
        const before = structuredClone(state);
        const source = rngFor('t4-33-baseline', name);
        let calls = 0;
        const rng = {
          ...source,
          next: () => {
            calls++;
            return source.next();
          },
        };
        const result = runCommand(
          state,
          { generalId: 1, tick: 100, unitSet: testUnits },
          'attack',
          { cityKey: 2 },
          rng,
        );
        expect(state).toEqual(before);
        return {
          name,
          sha256: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result)))),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
          calls,
          next: source.next(),
        };
      }),
    );
    expect(actual).toMatchInlineSnapshot(`
      [
        {
          "calls": 6,
          "name": "수비 둘과 성벽, 마지막 도시 멸망",
          "next": 0.5024574538692832,
          "sha256": "bdbf8afb0f0fdd00e7552f4f7c8eb1f215953ad8efe7ece016ec8fe4ff08d8f1",
        },
        {
          "calls": 6,
          "name": "동률 수비의 ID 순서",
          "next": 0.8002542273607105,
          "sha256": "bdbf8afb0f0fdd00e7552f4f7c8eb1f215953ad8efe7ece016ec8fe4ff08d8f1",
        },
        {
          "calls": 20,
          "name": "열 페이즈 뒤 양쪽 생존",
          "next": 0.7206481471657753,
          "sha256": "fd504e3f3f0c510459979a067904e6444dfe6ac156f0a83009dae0eab9eff792",
        },
        {
          "calls": 0,
          "name": "공격군 기아로 전투 전 사기 소진",
          "next": 0.3639177978038788,
          "sha256": "a3e9c0e93881e02eb1d308ba10624b97bdcec5b4918fd1003fcf899c5b9039b2",
        },
        {
          "calls": 4,
          "name": "수비군 기아로 전투 전 사기 소진",
          "next": 0.08207402820698917,
          "sha256": "e352ea8b51a23395971227e60bfa12e2637fc8b1b127e2dbf70999b71b6bcea3",
        },
        {
          "calls": 2,
          "name": "병력 하나씩 동시 전멸",
          "next": 0.2810764138121158,
          "sha256": "26cc44f7ad3bde6aa0885d433f1752c13c227d1dd09b3e161a86774d3a7ef4f5",
        },
        {
          "calls": 20,
          "name": "양쪽 사기 동시 소진",
          "next": 0.45156482700258493,
          "sha256": "0437ca955c67d3e1c24a4f4dd70cb03343d0076244661a90d11c6c21e948b310",
        },
        {
          "calls": 20,
          "name": "수비 없는 성벽과 방어 보정",
          "next": 0.6770514904055744,
          "sha256": "20869a40036d986fcff0a33777e0cbb65235a590cb88331ae8dff807056946ad",
        },
        {
          "calls": 12,
          "name": "병종 상성과 양국 기술",
          "next": 0.6161481768358499,
          "sha256": "c86c6d8d62008e996a6c099ca507d1cc58972c89a9e53fedb50bf8ad25b71878",
        },
        {
          "calls": 0,
          "name": "수비와 성벽이 없는 도시",
          "next": 0.1679761114064604,
          "sha256": "279d6dd3923889890198aa0c27dad93b55711d11c9548f3f3b253788c4abf303",
        },
        {
          "calls": 0,
          "name": "병종 누락 사전 거부",
          "next": 0.349462800193578,
          "sha256": "02c9426b9a1209a1ecd84a14a3f173ff8f22017cc4f9d2badb4f3b3489d47a1f",
        },
        {
          "calls": 0,
          "name": "교전 아닌 국가 거부",
          "next": 0.4288955475203693,
          "sha256": "1e23bf26d06c365b5cf76e760b1bf98e26d80091a6dbae51d91a0a58e59f3a73",
        },
        {
          "calls": 6,
          "name": "수도 함락과 같은 인구 도시 천도",
          "next": 0.9483208600431681,
          "sha256": "983dc1766037f66ba2471c70a7e8f5a790d0ffae5959dba5aea52f95689d0419",
        },
        {
          "calls": 2,
          "name": "훈련 미달과 미등장 수비 제외",
          "next": 0.46699898410588503,
          "sha256": "ceaae56ab653b62f5c4d99ee8590d57976dbcfc62aa2246f8b03fa1333d8878f",
        },
      ]
    `);
  });
});

describe('AC-M2-19 전투 전공', () => {
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  const execute = (state: WorldState) => attack.execute(state, actor, { cityKey: 2 }, rngFor('battle-awards'));

  it('야전 상대마다 승리 1회, 도시 점령은 별도로 1회를 기록한다', () => {
    const state = commandWorld();
    const before = structuredClone(state);
    const result = execute(state);
    expect(result.battleAwards).toEqual([
      { generalId: 1, wins: 1, captures: 0 },
      { generalId: 1, wins: 1, captures: 0 },
      { generalId: 1, wins: 0, captures: 1 },
    ]);
    const after = applyEffects(state, result.effects);
    expect(after.cities[2]!.nationId).toBe(1);
    expect(after.generals[2]!.crew).toBe(0);
    expect(after.generals[3]!.crew).toBe(0);
    expect(after.generals[1]).not.toHaveProperty('wins');
    expect(after.generals[1]).not.toHaveProperty('captures');
    expect(state).toEqual(before);
  });

  it('공격군을 격파하면 수비 장수에게 승리를 기록한다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 20;
    state.generals[2]!.crew = 10000;
    const result = execute(state);
    expect(result.battleAwards).toEqual([{ generalId: 2, wins: 1, captures: 0 }]);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.crew).toBe(0);
    expect(after.cities[2]!.nationId).toBe(2);
  });

  it('수비군 병력이 남아도 사기가 소진되면 공격군 승리다', () => {
    const state = commandWorld();
    state.generals[2]!.crew = 10000;
    state.generals[2]!.atmos = 20;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[2]!.crew).toBeGreaterThan(0);
    expect(after.generals[2]!.atmos).toBe(0);
    expect(result.battleAwards).toContainEqual({ generalId: 1, wins: 1, captures: 0 });
  });

  it('양쪽이 살아서 교전을 마치면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[2]!.crew = 10000;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    for (const id of [1, 2]) {
      expect(after.generals[id]!.crew).toBeGreaterThan(0);
      expect(after.generals[id]!.atmos).toBeGreaterThan(0);
    }
    expect(result.battleAwards).toEqual([]);
  });

  it('양쪽 사기가 동시에 소진되면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.atmos = 50;
    state.generals[2]!.crew = 10000;
    state.generals[2]!.atmos = 50;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.atmos).toBe(0);
    expect(after.generals[2]!.atmos).toBe(0);
    expect(result.battleAwards).toEqual([]);
  });

  it('양쪽 병력이 동시에 소진되면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 1;
    state.generals[2]!.crew = 1;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.crew).toBe(0);
    expect(after.generals[2]!.crew).toBe(0);
    expect(result.battleAwards).toEqual([]);
  });

  it.each([0, 10])('수비군 없이 성벽 %i인 도시를 점령하면 점령만 기록한다', (wall) => {
    const state = commandWorld();
    state.generals[2]!.crew = 0;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = wall;
    const result = execute(state);
    expect(applyEffects(state, result.effects).cities[2]!.nationId).toBe(1);
    expect(result.battleAwards).toEqual([{ generalId: 1, wins: 0, captures: 1 }]);
  });

  it('무주공산 점령은 승리 없이 점령만 기록한다', () => {
    const state = commandWorld();
    state.cities[2]!.nationId = null;
    state.cities[2]!.wall = 0;
    state.diplomacies = [];
    const before = structuredClone(state);
    const result = runCommand(state, actor, 'attack', { cityKey: 2 }, rngFor('unowned-capture'));
    if ('code' in result) throw new Error(result.message);
    expect(result.battleAwards).toEqual([{ generalId: 1, wins: 0, captures: 1 }]);
    expect(applyEffects(state, result.effects).cities[2]!.nationId).toBe(1);
    expect(state).toEqual(before);
  });

  it('성벽 공격만 하다 패하면 승리와 점령을 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 20;
    state.generals[2]!.crew = 0;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = 10000;
    const result = execute(state);
    expect(result.battleAwards).toEqual([]);
    expect(applyEffects(state, result.effects).cities[2]!.nationId).toBe(2);
  });

  it('검사를 통과하지 못한 출병은 전공을 내보내지 않는다', () => {
    const state = commandWorld();
    state.diplomacies = [];
    const before = structuredClone(state);
    const result = runCommand(state, actor, 'attack', { cityKey: 2 }, rngFor('rejected-battle'));
    expect(result).toMatchObject({ code: 'NOT_WAR' });
    expect(result).not.toHaveProperty('battleAwards');
    expect(state).toEqual(before);
  });
});
