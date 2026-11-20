import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/builtinCommandFixture';
import type { WorldState } from '../model/world';
import { applyEffects } from './effects';
import { attack } from './attack';
import { runCommand } from './registry';
import { verifySuccess, verifyFailure } from './contracts';

describe('attack', () => {
  it('성공', () => verifySuccess('attack'));
  it('실패', () => verifyFailure('attack'));
});

describe('AC-P2-24 공성 병종의 성벽선제', () => {
  it.each([0, 1, 100_000])('성벽 %i일 때 수비 장수와의 교전 순서를 판정한다', (wall) => {
    const world = commandWorld();
    world.cities[2]!.wall = wall;
    world.generals[1]!.injury = 17;
    const unitSet = structuredClone(testUnits);
    unitSet.crewTypes.find(({ id }) => id === world.generals[1]!.crewType)!.effects = ['wallFirst'];
    const result = runCommand(
      world,
      { generalId: 1, tick: 100, unitSet },
      'attack',
      { cityKey: 2 },
      rngFor('che-wall-first', wall),
    );
    if ('code' in result) throw Error(result.message);
    const rounds = result.logs[0]!.text.split('\n');
    expect(rounds[0]!.includes('성벽 선제 교전')).toBe(wall > 0);
    expect(rounds.findIndex((text) => text.includes('성벽 교전'))).toBe(wall === 0 ? 2 : wall === 1 ? -1 : 3);
    expect(result.reports?.map(({ generalId }) => generalId)).toEqual([2, 3]);
    const state = applyEffects(world, result.effects);
    expect(state.generals[1]!.injury).toBe(17);
    expect(state.cities[2]!.nationId).toBe(wall > 1 ? 2 : 1);
  });
});

describe('AC-M2-18 실제 출병 대상', () => {
  it.each([10000, 0])('수비 장수 없이 성벽 %i를 공격해도 점령 전 국가를 반환한다', (wall) => {
    const state = commandWorld();
    state.generals[2]!.crew = 0;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = wall;
    const result = runCommand(
      state,
      { generalId: 1, tick: 100, unitSet: testUnits },
      'attack',
      { cityKey: 2 },
      rngFor('notification-wall', wall),
    );
    expect(result).not.toHaveProperty('code');
    if ('code' in result) throw Error('실제 공격이 필요합니다.');
    expect(result.reports).toEqual([]);
    expect(result.attackTarget).toEqual({ cityKey: 2, defendingNationId: 2 });
  });
  it('거부한 자기 도시 공격에는 실제 출병 사실이 없다', () => {
    const result = runCommand(
      commandWorld(),
      { generalId: 1, tick: 100, unitSet: testUnits },
      'attack',
      { cityKey: 1 },
      rngFor('notification-rejected', 1),
    );
    expect(result).toHaveProperty('code');
    expect(result).not.toHaveProperty('attackTarget');
  });
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
        const legacyResult = structuredClone(result);
        if (!('code' in legacyResult)) {
          expect(legacyResult.attackTarget).toEqual({ cityKey: 2, defendingNationId: before.cities[2]!.nationId });
          delete legacyResult.attackTarget;
        } else expect(legacyResult).not.toHaveProperty('attackTarget');
        return {
          name,
          sha256: Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(legacyResult))),
            ),
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
          "sha256": "f039b41e966a564e1b58cb05c62247d5ea5a3a6a8566e69d4005f1438274db83",
        },
        {
          "calls": 6,
          "name": "동률 수비의 ID 순서",
          "next": 0.8002542273607105,
          "sha256": "f039b41e966a564e1b58cb05c62247d5ea5a3a6a8566e69d4005f1438274db83",
        },
        {
          "calls": 20,
          "name": "열 페이즈 뒤 양쪽 생존",
          "next": 0.7206481471657753,
          "sha256": "3361e25c542b77571d85ec828b9192f78f5cbba1e09a8e06eb394155314eb057",
        },
        {
          "calls": 0,
          "name": "공격군 기아로 전투 전 사기 소진",
          "next": 0.3639177978038788,
          "sha256": "668f6b6dff8e62ee480e3d3c77c563a35ae5b8311b834c9eff9f1543019071a7",
        },
        {
          "calls": 4,
          "name": "수비군 기아로 전투 전 사기 소진",
          "next": 0.08207402820698917,
          "sha256": "543c706a37ff8cba75f80abe3869dd603241d7cfff53d80c58fef2244acbe07e",
        },
        {
          "calls": 2,
          "name": "병력 하나씩 동시 전멸",
          "next": 0.2810764138121158,
          "sha256": "af2d84766ba940034112d4b1daea1529cdcb9073759758acfb9a5743a97087e9",
        },
        {
          "calls": 20,
          "name": "양쪽 사기 동시 소진",
          "next": 0.45156482700258493,
          "sha256": "a571f95bf57084ace93ba532fb8286e42c786f031e19486d545b8d052bae4227",
        },
        {
          "calls": 20,
          "name": "수비 없는 성벽과 방어 보정",
          "next": 0.6770514904055744,
          "sha256": "55022594c46494491d47d99067c964e1fa7b4b9c4697492fcaeca5814722e1ad",
        },
        {
          "calls": 20,
          "name": "병종 상성과 양국 기술",
          "next": 0.1869112327694893,
          "sha256": "a7661a7418f8142c5b717f9e1e9100789799062b849aaf56631e527c8a2f33bb",
        },
        {
          "calls": 0,
          "name": "수비와 성벽이 없는 도시",
          "next": 0.1679761114064604,
          "sha256": "851199d49ca10ffcc0c6eafc330219b08454d27c2556fd7b344abb251eba5ec0",
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
          "sha256": "ba44ead6e805f90bd58ff687a3a4dd31bbe47afa0f24f47eec5e0e6812a675b7",
        },
        {
          "calls": 2,
          "name": "훈련 미달과 미등장 수비 제외",
          "next": 0.46699898410588503,
          "sha256": "ee8bc879a2b34e6d69ada8919ffbe7c84ecc39890d9d8efa43bb93cb12d38fe6",
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
