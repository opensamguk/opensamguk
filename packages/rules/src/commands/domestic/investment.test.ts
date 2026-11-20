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
        "sha256": "95ca766ef77b2632048522f5bcce6486e7dc0470720d847d303ef8f3934e8e13",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "728f27b20952befd2c0f04f43103bc735806cb02093f05756ca06d2439e7bbd1",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "1a9c5522a7bcd57b4b8e59071b9b3f9bd533167efac582d0364fd98a1935677d",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "0afb06b09346428d0197f12df1bf8f72a38e3b022e809307c65750f1a30defae",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "8483cc99890882d942c002e7c8ba904b58366fe63527311e8c0e426c7d3eae84",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "2d59748e948ff54d401c10eb699d1cdb63712e57b448fe1a65b4795bbd66dcb1",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "34a041b266e3940c3578f8df8ed90efa439aad0862f88424ef01230327c6b36d",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "a3bfdb1b1fbc651978811026bcb9ad13b5221b71374b5c7ee0f4db3f2036f3d2",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "97ab3fabde1201275ecb690ed2500df9cd0c186868d08f1a81d6866d0194f48a",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "153ddefb4d1ed067f7cafff85a02f2b71ee48520e44ff2d934a116bb2c9890ad",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "9d3fad31f20870c8be15c2520c5c2c8fa25ed2cda1ab413b8cbde438dee59fcd",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "0520dfc61e1db57d9f809203fd8a8f2ce209e16dd88319923ea55d02934514e2",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "0828fbce0f1090571bf846e5fb009e4eb73f86da762d475add9e10dcb7082ada",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "fc2ebb32720edede2c9a2c7eea86ae572529f6529c2ad87f35f527995e0f87d3",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "6e3ddc57a94896908c293bbee9e802e11cfaad86d14c46dba4ffb6f276dbbd33",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "c5a77f438adbfab85f566afce34ec53642f463d32dc77ee272e244982d363d09",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "ee5aae8ce2955a50e126a57ebe389b3478595c58f93b0dba8e3cdd91e4af8ec2",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "bd57a62b16e1c02dbc6c8babb59c6c975359036e8c8537ad688d96da119b7ad5",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "697ab2ff893365ef73561ac2c52be35e192da21bb3d462ecfb78e917559f10d1",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "d9a2958ac793498f86f2f294aa94091a53b5dce93d65b2b67e6cd745a91dbcfb",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "11e3ff7cb221ab540a9ee421918698108e800f56eeed3e34355ccb7f0b60600b",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "06cf07b5679ffd2891c3dea6e9fc6a6e1b3f7e7bcee2dc5d87d3f2e2372c3762",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "5b7f8ec300d5336d26aadde37478668b05cb5a77d8e59088d73548836350cc46",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "3138e619127d1e19ab60cfe76b25cc9d2cad1d01bd67a9cdc6757edf30763839",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "fbbc5a2e3c1c1bb7dd86e86d32aab71b27591a0b33f7b0a2a14b75d01e9e83bc",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "6163f9601744745b3c0a8d1e8532ab190224c85e8b7b6b629160477f86619750",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "1c0962794d1fa05ac9860182f64e3e51175e7bb33bafd2e9ea1617aaaeafdbc9",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "820786c6142a8776274bbe2b63458518f05e096608516e294c21f8778e0bf1de",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "cbf274789f3bf1d77557fee0969ab547c941cd021606bceddfa0e83f81df8b40",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "560fb266ebd88b27d96fb899c73384d09bf55602d462e9393263a7412445da61",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "645195a58ff652c7ea4efdeac8678bd21bea73626767e98a34fae533882b0ac9",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "beb6ab0142ebd3f489b184ce5a97270a97ba28befd657c2cafcce7fc598b4831",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "73afc89559d5effc14c2036184e2182e608222439353f272de48ffc1dabd04f4",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "b336564a1351ba69708d5156f0b2014b5a785941237ad42b221b6deba78e7d19",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "8fdaa31ef5562bf6e6dc9a91fe2737d18237daf5cde90bf827f5fa3f231ab26b",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "20d2b44aeb839ebf9748c589f02c4daa26cd12013e9f7785f6cc16fc343b944c",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "f86d66b56296fa47d349330fd9cceca131d5e76e983b6e283f5e11e0607db91a",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "a648b0c433c40cb493fc7655b665edee12b28aa699d9ff52ce86801de277889c",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "381ef698b4886d9d3fdb3a9f7027ce7edcb94810b5dd2d5214a02dff000c339c",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "bf0bace2ff9d01b13abcc80d2306336b7a6a64bfdded56e5717ca9a9f1590f61",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "7dff07649968b8b3793c0fafd20e657b9401fd1b338eaf9b807c43a3b673cd1d",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "70016517ee20568905cfb1073878ab4d935fd4c45a395644c5166542603d5140",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "b83e1b0052acc3e9de165dfd5b6e78095de55f853116af0d0f82e39ca2a5d0f3",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "7555a5248a2adb6de1a86bd63648296d91d28b58b0ac9105db63bbcc35cd5973",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "13d1d08d74b0085fb7e354ca4b6e288a951838f366f31157392b5e308822ab1a",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "e59f8bc6a69f64357152aaa88b55586bf3cacb46ba686c56f92d76ec6ab62236",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "3360ddd65de542ace54f36b49b47eaa71e7fcaed11e41bb84f3c2722d96b0bbb",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "65eb3a1565bde969377581c712f363d5a974d8db5f31b3dc580565ac3e939a10",
      },
    ]
  `);
});
