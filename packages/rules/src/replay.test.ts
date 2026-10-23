import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../test/commandFixture';
import { initialReplayState, runReplayAction, applyRecordedInput, emptyTurns } from './replay';
import { createCommandResolver } from './commands/resolve';
import { applyEffects } from './commands/effects';
import { runMonthly } from './monthly';

// shared/node의 canonicalJson과 같은 JSON을 Web Crypto로 해시한다. rules에서 node 모듈은 읽지 않는다.
async function stateHash(value: unknown) {
  function canonical(entry: unknown): string {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    if (typeof entry === 'object' && entry !== null) {
      const object = entry as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(',')}}`;
    }
    throw new Error('JSON 값이 필요합니다.');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 구현 전 main 0115e6b의 실제 순수 재생에서 얻은 월별 해시다.
const golden = [
  'f93d220178b8a0cf85026aef3d596031a82640a3d632724b7a269595f66ca8f4',
  'd7e49727dbc9f8965c1f84c14058ec270f79f754813e87b5822185c7b24381dc',
  '4d687703923aa765c9d139661b9ec8c125288430ed0854a57619c0afebef9a66',
  '236bf37102a665d23f325f4c5cb079ce8ee35497b675f5f06f5dc4225e3a6953',
  '24e8d0e418d9c92f23e3ac492d4a3b602f348d33b8f64118930b3b08cb8c8d25',
  'cd6c5fc7216cf37696d1e1913e727322a6d83ccabf9dee93e466295fa8e5c82d',
  'b944c427d09bc325625e4380be2d0177b0ebfed3ca5af9ec30f9d79ee2cd4591',
  '93b00015217e5aa7965baa82e9567acc0aac64bde42cc03de01a87ad992c88bf',
  '87493eeed616bdaae4d9345b7ee37018809d3b681b76fc91effb1210c7a56571',
  '939bc0e6c665292e8e57229dfdbbad8d48a76ee5581ee1c68d6a14bb502c1e2b',
  '70180ae23c10dabb6d751c94ff4d819eaec37de69f547860ee860c64af091af9',
  'c478488cc5bb82f8fbc74f0de9e3fb875554fcc3814314ee948c6141bb14d9b1',
];

it('끈 월드의 12개월 재생은 기존 v1 골든과 같고 모든 단계에 ext 키가 없다', async () => {
  for (const resolver of [undefined, createCommandResolver(null)]) {
    let replay = initialReplayState(commandInitial());
    expect(Object.hasOwn(replay.state, 'ext')).toBe(false);
    const hashes: string[] = [];
    while (replay.monthlyTick < 120000) {
      const prior = replay.monthlyTick;
      replay = runReplayAction(replay, 't4-02-golden', testUnits, resolver);
      expect(Object.hasOwn(replay.state, 'ext')).toBe(false);
      if (replay.monthlyTick !== prior) hashes.push(await stateHash(replay));
    }
    expect(hashes).toEqual(golden);
  }
  expect(Object.hasOwn(applyEffects(commandWorld(), []), 'ext')).toBe(false);
}, 30000);

it('운영 목록 밖 ext는 장수 턴 실행에서 조용히 버리지 않는다', () => {
  const replay = initialReplayState(commandInitial());
  replay.state.ext = { test: { nested: [1] } };
  expect(() => runReplayAction(replay, 'ext', testUnits)).toThrow('test');
});

it('월간·기록 입력·장수 턴 없는 12개월 재생은 시험 ext와 JSON 왕복 해시를 보존한다', async () => {
  const initial = commandInitial();
  initial.generals = [];
  let replay = initialReplayState(initial);
  replay.state.ext = { test: { nested: [1] } };
  const original = structuredClone(replay);
  expect(await stateHash(JSON.parse(JSON.stringify(replay)))).toBe(await stateHash(replay));
  const monthly = runMonthly(replay.state, 10000, rngFor('ext-monthly'));
  expect(monthly.state.ext).toEqual(replay.state.ext);
  monthly.state.ext!.test = 2;
  expect(replay).toEqual(original);
  while (replay.monthlyTick < 120000) {
    replay = runReplayAction(replay, 'ext-monthly');
    expect(replay.state.ext).toEqual(original.state.ext);
  }
  const withGeneral = initialReplayState(commandInitial());
  withGeneral.state.ext = structuredClone(original.state.ext!);
  const applied = applyRecordedInput(withGeneral, {
    sequence: 1,
    generalId: 1,
    kind: 'turns.set',
    status: 'APPLIED',
    payload: { turns: emptyTurns(), revision: 0 },
    result: { revision: 1 },
  });
  expect(applied.state.ext).toEqual(original.state.ext);
  applied.state.ext!.test = 3;
  expect(withGeneral.state.ext).toEqual(original.state.ext);
});

it('순수 재생은 resolver를 국가·장수 실행에 전달하고 메서드 수신자를 보존한다', () => {
  const replay = initialReplayState(commandInitial());
  replay.state.generals[1]!.userId = 'user';
  replay.state.nationTurns = { 1: [{ commandKey: 'nation_rest', args: {} }] };
  const base = createCommandResolver(null);
  const keys: string[] = [];
  const resolver = {
    ...base,
    run(...args: Parameters<typeof base.run>) {
      expect(this).toBe(resolver);
      keys.push(args[2]);
      return base.run(...args);
    },
  };
  const result = runReplayAction(replay, 'forward-resolver', testUnits, resolver);
  expect(keys).toEqual(['nation_rest', 'rest']);
  expect(result).toEqual(runReplayAction(replay, 'forward-resolver', testUnits));
});
