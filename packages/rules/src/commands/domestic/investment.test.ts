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
        "sha256": "a5db4fcfde8d8fd5dbb1a239cd5d474df7d51a61932410f77dd4993215eb4e47",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "ae4fbb26fb788bb7f5771862dead789c32fe2d0d98419ce2755dd28e374d5deb",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "4980465b8156da8de013c80e566f0fe52deb90a309ad76df53e2812e0efc9f21",
      },
      {
        "calls": 3,
        "key": "farm",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "daa35618ce3d52a3edc8efe6f54117a134a677a9a8e50e1cd270ff1f449e156a",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "27539bc168452e7801e365600ed775efeed4832b17f0dc34850e93f351ac347f",
      },
      {
        "calls": 2,
        "key": "farm",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "485c7a790cd63845fc9aecb83ff96bfeb20bdca31c7a3b36e78f5aa68c694dde",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "518842715ea5c1703d8e4d102cfa8fec9179a7ed202df317734e00909d06d371",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "ae8d74707db771d83b79d2362c415e674a1b6513d8955f19136511380aa4556c",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "f2b2609bfb2b254e81951a1db80071c9678a89df9c13d653499255b5d32dc2bf",
      },
      {
        "calls": 3,
        "key": "commerce",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "bffeb36d88b974089dfb4136fed72b3051c575064cb55782e260c4a29c076cce",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "f0ad229905f3f103f8a91855eaffe8cb7609d20f17e99f13aee79dd80a63e73f",
      },
      {
        "calls": 2,
        "key": "commerce",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "d02ccfdc8093bcd7d1a70bcc58fc3097f8ce727fccc0aff587b79f464a64c01f",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "860e33a6fad62b804c1bc4897372d9f6e5feb3ac659c405b4e4c96adc937f030",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "90916b9b46e603e8da440a31b199ca6634dc4c846e0946d139ff8184c0beb9fb",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "169cf9404116137f7a4b1d62f4ccb5263e296d1a921e20bf027896aa7727c260",
      },
      {
        "calls": 3,
        "key": "security",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "751f81a37338ae34970bb57906b8dc9a4cda8e6518bc80deb59a06d426055c7b",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "c41dceb09c1d602c10eca0c98987c9d7c8d0b9a60f59c00a7f66bc6c9e6db9c3",
      },
      {
        "calls": 2,
        "key": "security",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "ff936bdd1d6958656323c7d00b35e4bb66fc3af01d066f371277726906095f28",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "2117e2f49d3016945ca37ab1b9a28e62395fee1c790a19d6aab8718066f633f0",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "82482556f7b8e983e11550f017e49e4e1e9b0acd9ef34aaedee0aaff3158fc0d",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "fa993286d106ef721e38a57d27403ae149a0b921a19b13766f38bc45d8a041e6",
      },
      {
        "calls": 3,
        "key": "settle",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "dfb5b5d8b6bfd412882c04e98c68043bf9813c29ce2a339340cd0d4d126829c6",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "a67ef79cdb74b50704a38aaac6b023d832a80aa90126ee04171e058e158c723c",
      },
      {
        "calls": 2,
        "key": "settle",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "d09239abe741dc9d653011071c58b40b1a9c64d732217e1b30c7d569a7fa2bda",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "364f633770648be6a1609dd55e98de1748dfc1ebb5fb75ac60d1ba5b750c880b",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "ff0c4f20cba057a59bec7f558541b16ef288ba4fa9ed89d4a11f2eb8ee500ac7",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "05deab7ce9d0452fa46394d23d9f27ffc1345fd1faa3deb298f048a3590c2138",
      },
      {
        "calls": 3,
        "key": "goodwill",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "572e8736e9c58c243233bbc816e9cfebdc8a4844ec91a5cc83bef81dca48d2a6",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "ed953240ce25b731309dd2006d664fb1c604eb56262223b37b2ab73f119bcd27",
      },
      {
        "calls": 2,
        "key": "goodwill",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "d4da86cda2176848a5e0586d28c3fc008f92aaa8cfef2b358292f317b0d0f011",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "3dbf0e5ce17abc6052659bfb3d9de6038b38f38802f28ae607547f055f3fcb66",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "c4a2455c2aad96a0541cb2826c8ed5b33dbf73d0fcc8808ff7b16e4d346cb9a2",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "f17c88b12ddc69b879928a2a18889f926a3286de4dcf5ce5d85aa41276125934",
      },
      {
        "calls": 3,
        "key": "defence",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "ef73536d127c2fa4d3ae4ca88aaad80468476be776707d6e9c1bfa81e9d8b8de",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "033c24e8877d034b92d7c425b687043dc7e51fa6ba7d7920e8c26cfb8f1838f3",
      },
      {
        "calls": 2,
        "key": "defence",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "846fbf636ac2525f00ae268489123546a5f0c8b52989e1329ee441a95205a71b",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "a2d751b549da215ca056a58628aa2740e10441b5763ffd1b3b2eae1d4a15e9fa",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "a5c48f9033c3e7a276633f1d4518c8200c42c2ba6c176259d7548142197ac8a4",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "b36bf7d9311a923f17ba9a16a6d9d050edae86303c96f62aff26feb8ad13c0b7",
      },
      {
        "calls": 3,
        "key": "wall",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "e521dc7cbfecdac9183a7c2d8f72df9996214c68ad0ea621d80c124e9a7b30f8",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "40efb1d12b17f7b3f999b25169ec9f91422b94fb523f0e1a09db317238c166b8",
      },
      {
        "calls": 2,
        "key": "wall",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "9a2802bf800057edad53b8fcfa744426f15ac9ec4ce3863b2c1449309c31bd2d",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "일반",
        "next": 0.11434290511533618,
        "sha256": "d52a7f65d4bceadc47308277ff6e1a4ebb9d46ac22603c205465bd0df83b3d8e",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "전선",
        "next": 0.11434290511533618,
        "sha256": "a814619827ddab5fe61a5ea3b191ba24aaa92f6dbee6498d51fd4805d70facc2",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 성공",
        "next": 0.939941311487928,
        "sha256": "86f286a0afc392abc52ab84329f3c11d0f784108413b5e5c649486fc442938b8",
      },
      {
        "calls": 3,
        "key": "research",
        "name": "치명 실패",
        "next": 0.9854359365999699,
        "sha256": "d66ab101b60af4f21ef36212a496c55f0e15b3f08e78d2bc440450a2b8eb8060",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "민심 0",
        "next": 0.11434290511533618,
        "sha256": "01485d26c0d8c6d57891ff1c33cb06aa17629b694e6f7f90cb6e63772fcd7e7b",
      },
      {
        "calls": 2,
        "key": "research",
        "name": "최대치 직전",
        "next": 0.11434290511533618,
        "sha256": "e7c98806a0ecb14f7a5fd5a6528a0b70ca630746a4a29e4d0c0220a8db2ed743",
      },
    ]
  `);
});
