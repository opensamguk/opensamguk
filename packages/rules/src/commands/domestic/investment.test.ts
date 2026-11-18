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
        "sha256": "8c9c017c850579837684b3519e12f0e69cb936d6d5702ec5b26760d1bdea8815",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "5a3562b1205924874a39909b9712f3b86aebfe7901ab3ca94936f2760542611f",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "1ca33ad968b9b2b60bf90a42d8a9910618e7b98f124ad9be5730c2ec1d772529",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "f0acf1fa9d3f6839bceae6f3d020967f27fab772d8d372a19dc72cce2ddd4379",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "c4f0ca43f034f4290456fe51fa16367eda8ce354720ef8d496df10c08bec9333",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "51c6e7675bf15aeb800aad92198cf2eb59a67c4d4a49820f252ae0e7fa7a39cd",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "f72194e9116ebbe147bf819276aafb6774587433be1c8e24075f00af20780e8c",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "022ee5a61d8ecbdc9e9216003ca71c1ebd4cd701cbe8be15ef0bd6a287aa3c6c",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "b0bebce125d0002e880d61a10af99bfc536d1b3f295000403cc64fc9d8e6c98b",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "2cc22780e08d41266c1f8dcae2b1f24e4a0ed94e19307606ac6a31193d531727",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "9506a36e21f3106b22aecc4510cb4c116fb3c2cef7c35e41e61f3c0def11687a",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "e421d4515967bdf074a73aaa10769b0b7bc4d1f34c06316e2fd28d37050ce61b",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "9ac63d07b42c58c9538f3f3ba1b3fe924e37f2bfce2b5fc86aa6e02b960f8fdc",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "2506b3f2d213d3fc468efebd7d0e9e839463b87298c2f0f8833bfd44b704acb0",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "080ff094be4e0fe9a8eb7d4e439690b544b93503f82638531464bf51e03903a0",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "54fec3e83bc156ace63123e414f12e1230ae98f130013e3c5e0958ce04117fdf",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "28d863423bab5b70ba8a7ac71c08ef28033a53170f418621e42eeb6e0d20c0b3",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "f046706c29c3fade4bdf979a6bd5fd977f160137b7d33a90ac612ccf97802e46",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "820cfbc86ab5e6b33e5cccb4e0e429fd74259a5ae3508a919be64864f0bfa649",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "ac39c82acd1dff90604f18f01db8fa680b0e69412c85ddcbb102878188c39081",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "ff63167d113c5fa8d3bb63ccec4312b6c0b6d90957edfa0744401617a6609de4",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "2eda0008ad6b3816e66f22338af81ed68d2f6c3e155da931c10da2a1a107d3e6",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "45cd89799d8f550cbe9e84d807dadd60eaeca766e35aa463ad61d94530e4a343",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "2d3cb192587071081d8b0e9bcdc6bffe8b80ee4aa8db33fd9a2760b17df403a7",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "d01c8b34b7aa224ff255ffce47ee29ee0df616e698028e25850153380bb0e05c",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "21e8e109bf5f340e6d3e855b1f258e509e4b3fcc5f23df8bcb09f417671a3c5d",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "c2c9af1bd25c861304bfb2d809f33c39fce585583ef8978f7b2774653654d6a2",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "901c3762bfa187391e003bd405c8483d28a75b3137e4c250d51352eaf7c7bc87",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "c7b78ebfdb2619d7c3b504c735088fc77fc14afd3e5be186999316e9fa3ada3f",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "78022aea2ada1dbf6478702d808526dea16f208f97c7fef55f54ea635494d7fb",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "ff049a2930a9bab2d23e7b0af47479cc96f3a791d57b969ae0e9f5a0885249e8",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "ac23879a42283feb69ce732d9ffdcd9ac13d94069e96af90021c7715a250850b",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "6e6556b4d8c1d67e92d34bd32460d88ce051a0abf054b843d3e431ecc487b6cc",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "4e63d37cd2ddb3f36aa3cf446c3588a4a22618c86d52458375fc73fe5d71ba85",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "a414aeb659ac8aefc8649ced59e309b7f64042229d392b502750109900539e52",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "dca5b41ff4a0fea9af00d49b404cf33afcef97d93bb78a2847605b534da506ac",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "e061326720cd257469459fcfdc15e4a0c9848c51b9be3eae621886870acffbb4",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "5ef41eab59463b3a77071aa1ab7c1d15babcec057e0250629427a90f3b4e4be1",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "ab0623411e92a5aecc33a2ccc23a8fdf7a57d58062df773cd4eddaa42ce00efc",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "92df0905e8d35bc78c16e55f6d4cb50702be7bc622915bf37f27fbe5624852e3",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "d17d21c9707dfb810b3c1360c01a9f8ba0c741518699390cd8204146c676e2cf",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "15675a87fb0ef7cfae20fc0f6f45030940b4f94ca07111053749ccedfc9fd0bc",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "e3fe438cde8920b61c0aa2391c2a1b280b889f3adf73d396da1c3c69d9f46ff1",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "3b28e08ff39c3c7b9c91f3a1f107f4b61f356c7049760f1929569508bf2c7208",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "0db1a33db94a926787e0989fadc955c78c11101eab8136aec59063589cf8b305",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "f03abe5e6db143b69154a2781a302facc3025cd6e957f8ef8657f1d25d49cfb0",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "407fa1b4919485f3a0dce8543f6cc85879eac15447ac03709e5f8c6304366702",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "6d138597a5fa112b810fcb0e7c0c1ccf00510c0e2c2b446444ac3071cf1ca9d1",
      },
    ]
  `);
});
