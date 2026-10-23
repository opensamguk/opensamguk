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
        "sha256": "3d7115fba65410ca74a11de777c6c8de2f9b7ffc1612e8913ff265e113b337de",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "66bf0888780daba67ca4a6f8e8f5f1aab9bc4e837b85574cf46691b661fa4aca",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "383ddc688a70140ae14fc46ef6b516015c2ecad43def28fd342876f17de24db4",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "c453acf8f8eed1faff624b43a8a92c1b506cbfbbd27371764f182a7be2a37721",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "592caa3b96622ded2c1c29c5190137d0a8aac97324dd32646d1c2baf8b048dff",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "7e843d4c2b9176c1e803ba44d9d91ac0345c91acea363b616f66501f331514c1",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "999894a5069c40f72f9576a4fce46057b0a9869ecb01581656c5dd17c4d29d59",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "42758eab47dfdcc0e241508f0a1aa9bcc189bf5e7b2c23e25ebed575a750f566",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "ebed4e8f87622ac8cba4607d64955e95542bc6f2f037071048a34547c6c55049",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "9c75c68ffef8b0bda3696144c1f5cf6a92159692ca3437e43ebde810b07d3a73",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "c09fc2faa3c10fe9229d23f014c71c0f8c0e4e31660be17ff3a867f3baa5c4d9",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "ad59547cbe735a0f4e489c57c130747cec4928f1e4b256f421931675526f9479",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "d3a92333367067bb69230e10a69ce8e22b54135a6628f18bb2ee09e642b29122",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "a1abcbdcca613955510951517f64b8f234c489562d3da57f30c04fd2194b82db",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "91d071da5f70ca77323c9393bd06f96ce2f3fbadab33e2cde0cdd232816f77ca",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "330783aaef88c6e91f00b42afebbdd78a87e1b533dcdca0b9f236adcfe810b02",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "ecf484bf4ce2ac5562f03ad9a8b8834d4e93e4d377c4e48b94e7987fb9788415",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "ad0dfd53e6f99b9ccd762a1da2978f1369f21d3a1195bfc5ead2fe4c7c7b85e5",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "06f5535b53587306a45b26d99e018ddc97d5ddef4c6cd8786ef08feae258c47f",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "abf58913cf32f5205c9f5ffeba75d1b858555f4e946b7fdf5e125c81506ec973",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "9e52a1138d733d6f592b93852d95d50750dbc049cf3977ddf22864d943bc875b",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "0ebfc4fc81097021416b371a42e03941cb77abb1e28375f7be3730fc39de45a8",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "e86306c0a4145f877ea6fbc3fd14f17d985764799ed723175d4db733cc1b940e",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "50935548c83038750c7fabd424834e013c3e01bfffe8e9768ce581ee4cf2e98a",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "136c1792d0ee355a42b907e773bd203ab99fa5882cd0e71a95b000d8e78b3afa",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "f0b672a08594c7c67213122f87d8672864615f1f97f793b695ddfd3cb790d5d0",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "f53d61038d1a3ec585a28c74218355a218467f7ebaed7ec6658cc049ebf71d0d",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "c69d4c3f3363058e4e1e677f8d4fe64c4d9df279a170d4df227e9f5470d1a5b3",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "668e82f59e8b57b210631474484cd77734d64507f659d195b1dcfd6e502a756e",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "4153814e1206d7d9c2f04043a45b92c9bd447f35f6f2e0b881fd6a3b687bfb61",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "bdbd0f1c396014c3e6308e4d3e853ac3a47e993472dbac9ace9180ca8ae00938",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "3da0db0ef6738d0f9b4279fdb06c70c4b1f61945d4de6e228894841eba026a4f",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "8e78d9f990901b23fbdf248bda08fa76e92b96867d587cce03c0d56a24a2f0cf",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "030eb041bb99722614d07e0a90b93e33c65aa578d0b105e8c0be23958a3556be",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "d69bc0f2d396f06de4fcdf2471f8cf5bfd4db50ce1e666df0ae500e01e0ec183",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "9bac2841f9120e8501b3a930731f3ae153150111ec2c4febebdc66e21be6b6c6",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "5c99f8a4e06fcc3bab4055a45f6b43f8dafb69cf7f94bbcd16e47b502a2dc4f4",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "6e90b04b3d52a4b4cee3bd041859f291ce0a2f22c3b0115de5f2f088dc9799fa",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "89160feca0b5143683d57412d9ed91928678e58f485c670136d7c53cb887af24",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "ab276abe76c78c683d7461be4ac9b399a70a4a5ebec8990034b71df6e953028f",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "d48f8af5d5ce3b5019ea0ee8154ac88d7d51b7ecb288cfd6d1ae231633509f5c",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "3ea144f278ed15aa432839ade4d0725693a1dd23030c41474cca9eb7d093ae78",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "0f20ec2e7c8dc7a6b2e8621b3888f4877eb0c9fef774a77faff0dcc498dd95c0",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "7df2e940ecc60bf7c0a013bf4206c7bdbe87fa895af973ea2268bcac0637c813",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "a0033f078e1e776b691889bb095ab1ce8111623a706e10eaf8cde96dd4677592",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "0b71504fc41442d15dea8032388baf7e07391df3d33f8ef0a185f35a1e3a0a26",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "56342e4b3c84a6e5adae59c2287949a94cb5325b1cda5b71f6b19338754d660f",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "6b48f2590c36a8777d46b709b0d7c09e1e9cccdfe13d266a52ddcf38b5dd012a",
      },
    ]
  `);
});
