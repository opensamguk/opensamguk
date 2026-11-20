import { createRng } from '@opensamguk/shared';
import { expect, it } from 'vitest';
import { commandWorld } from '../../../test/commandFixture';
import { applyEffects } from '../effects';
import { DOMESTIC_SPECS, makeInvestment } from './investment';

// 기준 09604e71806b1f22012ab6df9026e02085d80a38을 git archive로 풀어 hook 구현 전에 실측했다.
it('T4-18 투자 8종의 여섯 경계 결과·적용 상태·RNG 소비를 보존한다', async () => {
  const actual = [];
  for (const spec of DOMESTIC_SPECS) {
    for (const name of ['일반', '전선', '치명 성공', '치명 실패', '민심 0', '최대치 직전']) {
      const state = commandWorld();
      Object.assign(state.logistics!.cities['1']!, { iron: 1000, wood: 1000, horses: 1000 });
      if (name !== '전선') state.diplomacies = [];
      if (name === '민심 0') state.cities[1]!.trust = 0;
      if (name === '최대치 직전') {
        if (spec.field === 'tech') state.nations[1]!.tech = 11999;
        else if (spec.field === 'trust') state.cities[1]!.trust = 99;
        else state.cities[1]![spec.field] = state.cities[1]![`${spec.field}Max`] - 1;
      }
      const before = structuredClone(state);
      const suffix = name === '치명 성공' ? 2 : name === '치명 실패' ? 24 : 0;
      const source = createRng(`t4-18-investment-${suffix}`);
      let calls = 0;
      const rng = {
        ...source,
        next: () => {
          calls++;
          return source.next();
        },
      };
      const result = makeInvestment(spec).execute(state, { generalId: 1 }, {}, rng);
      const applied = applyEffects(state, result.effects);
      expect(state).toEqual(before);
      const bytes = new TextEncoder().encode(JSON.stringify({ result, applied }));
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      actual.push({ key: spec.key, name, sha256, calls, next: source.next() });
    }
  }
  expect(actual).toHaveLength(48);
  expect([...new Set(actual.map((value) => value.calls))].sort()).toEqual([2, 3]);
  expect(actual).toMatchInlineSnapshot(`
    [
      {
        "calls": 2,
        "key": "farm",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "713d27e47c7adc3355f1eb0b760308c87785d0d0c08bf786e89fd9bca7e5f555",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "3c02c7bb97585ae1de249e2b84a73ad2ef122ad7288eaa0b70d52a273e108a95",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "f3567443e4e2b50179f7c50390a7fd2cd007f5f7f89769ccf2c532647a1f157f",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "ec34dda9003a125a92336b1ad57db241a930727667c4c72fa5b26ea226cc75c8",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "f5dab19a2ae4d7115e0a54eba87cab6e42f78a229b3ac42adda9cbd039006e01",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "67ef3dcc132c98a598757fd9cd41e592630e0ffa5b840f96f45617c6189c4bd0",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "4c308d405acd43f5e7ff8b7f35b1f402ebac268742011e41687fa7718553658f",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "709994adc7107a47cc61850682698522ca2a5eff9f1ae62c0aebc6dff60e83d7",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "336d27257bc98be9e23b084114e75e5c969bf8624f2dbe097d585fc7f67ceb9d",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "974f71902e5890815b04336d23d8f3318ea6eeb4570fd80b021b514ce044a6d3",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "a61d0d46304373179a430e3e8f12b81dd16bbe1fe1bba0f6e317224577bb7dcf",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "86eee2cd3d26d460e2172d74f12c40e55d487ce8d75e2ca570aeed5fd84df53f",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "44bd0a98459d210f43c607cc761b4abde0ef7e08f4b25a2ca4f797c4de4cc832",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "0a2b06cfc03a2a4049fa2739d214c165e28ab0157258559b17e7d160449572f3",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "2d09b3b1928e19e71483d0abc8b14a28951f7f3d208837c417cccc33fd577cec",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "a95b642c9676a5f089e1939a3d4cb5811ae14aa4eaa31e1217cca2c600261a03",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "c6fcfc5ffa12c677057cd8207fcd0293c164bb19d126846fc98fec6904983555",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "81c5249f1c8eb463b6b2bbed99b3bcb7ad697510ef784b2f0c9579ff767818be",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "57ed6774a7d8b1497a2b3bc0181699a248b85a8bdbcccbdd4ec61af85f6c79a9",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "68a5754de9bfab85a92129740122c680227b17ee74e3f6606af79f62219cdb08",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "c076d086164b7f44bfab41494624db872f0cf2924fd9cc7e244f7a5356083f58",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "9fab8fa702b1cd7031a027681f036580a852cfc9892c029573e61e6c4879b7be",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "43692a3fe40a6267594145648c012538bad27142dffd3902b06fbf331d317eb6",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "24c72007795d25f2a37b165240a33fcef496923fc5d35a04125060f3cad2eb20",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "1fcc27c610514dc4809b63bfb82b7d4d1ea0e0a63e081cde36111af04e1d2222",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "c6e9012ef72b64f564a2225f3db3349b0155e976eb5f0a74c6ea5362e0842877",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "af5e0900ed5e434f5ed1265e971efb1c74722d310ddb38a4d10f748c13860410",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "32156840f9e00bb3ca062c51e2e8d4b2f98164e6fa56864b4b3696d753e5043f",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "3e60788dd218723d18ad32675ed5f9c1dfa8390c1c67afa10fc6cd188a42a298",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "f4de6dfe493b7085bb24e6238cbb88be05adbe7bca667fc379a3a6c9d90b75cd",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "f8c09b81a2a7db41070de143356e25a454825453f9c8ac3457bf65fe3ad724d1",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "1bcff56261f4deff248c3b04f6008db7f5abcb984fde119c0c3eacb7ad7bd1ff",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "f433c3af0321c6e1d3053033445123df044980373edc65eecd8d86fa68b49f43",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "6d79c4337f8b4bb22dcc6dc52cc32056d24d68cdb0d55e5e00551bc525f67a1a",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "f35779aa8d7f4af6a1dd3ee1507dcc0dea789044441f6717dc17c268534966de",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "c710703b44270cd03c5a06c1e8c7a43fa13465d995459273ab46f40910725844",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "89d572cc48ef8dde34106a1de9bdd0fbd4157d520e061014aa2fd0aa04aa23a7",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "3d58f79b436ebc018cbb6c1e190add3c3fd1ea98f6c33da7aea901d67f533dc2",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "cc36de25d973ba81c8cce5383a2b0d9fea2ed70823e9a0116a132ac278b6c7d7",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "faaaaab1f831fb93cb61fc4166839c74dbe7b04e1e0808372688f6d9e586caa4",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "51875f59fa9d518edc179d661220d7a814e10877e72fe482b5b7ef837aa3d934",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "fd0da8af64edc2f88ee37abb57e8db663185b0cba7cbdff2738fe48a9f920c31",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "2ef07c118a20c25b4250de5537b0e60ed76ad5d27632936f6b0c90a9bb15ee36",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "784f891b39d57cb3fb414065c5557cf7e54d9615ef50c5ec3756e0ec45f4a373",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "e22ccad64cbe052334c7bc5246c5c851fb582cfd21d33f982b4f7f26c661a445",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "bda437de7f69c7439147e53281678b5b482eda669e1a7430f2baf51a85060bbd",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "9249710198ffb700ce34129df561c24871f535d6b0b57f7d1a06f7ddb7e9e9e4",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "21fa0efb8530ba289f464858ed2f11304ffa39f4f7a33e7648e5545c15bd4dd0",
      },
    ]
  `);
});
