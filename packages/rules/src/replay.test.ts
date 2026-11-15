import { expect, it } from 'vitest';
import { allRulesInitial } from '../test/allRulesFixture';
import golden from '../test/replay-golden.json';
import { initialReplayState, runReplayAction, runArchiveReplayAction } from './replay';
import { providedRuleKeys } from './providedRules';
import { ruleRegistry } from './ruleRegistry';
import { resolverForRuleFeatures } from './ruleCommands';
import { deepFreeze } from './personnel/testFixture';

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

it('AC-INT-28 모든 제공 규칙을 초기화하고 12개월 골든을 재현한다', async () => {
  expect([...providedRuleKeys].sort()).toEqual(ruleRegistry.features.map((feature) => feature.key).sort());
  const initial = allRulesInitial();
  let replay = initialReplayState(initial);
  expect(initial).not.toHaveProperty('ruleFeatures');
  expect(replay.state).not.toHaveProperty('ruleFeatures');
  expect(replay.state.ext).toEqual({ intel: {} });
  for (const key of [
    'campaign',
    'cityResources',
    'cityRuins',
    'logistics',
    'governance',
    'lineage',
    'equipment',
    'stratagemCards',
    'nationLifecycle',
    'nationResearch',
    'nationStrategy',
    'preparedTurns',
    'relations',
    'officeEffects',
  ])
    expect(replay.state).toHaveProperty(key);
  expect(replay).toMatchObject({ offices: {}, residenceAnchors: {}, reputation: { events: [], reviews: [] } });
  const hashes: string[] = [];
  while (replay.monthlyTick < 120000) {
    const prior = replay.monthlyTick;
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
    if (replay.monthlyTick !== prior) hashes.push(await stateHash(replay));
  }
  expect(hashes).toEqual(golden);
});

it('AC-INT-28 JSON 저장·복원 후에도 전체 규칙의 다음 정산이 같다', () => {
  const initial = allRulesInitial();
  let replay = initialReplayState(initial);
  while (replay.monthlyTick < 60000) replay = runReplayAction(replay, initial.seed, initial.unitSet);
  const restored = JSON.parse(JSON.stringify(replay));
  expect(runReplayAction(restored, initial.seed, initial.unitSet)).toEqual(
    runReplayAction(deepFreeze(replay), initial.seed, initial.unitSet),
  );
});

it('등록하지 않은 저장 조각을 실행 중 조용히 버리지 않는다', () => {
  const initial = allRulesInitial();
  const replay = initialReplayState(initial);
  replay.state.ext = { test: { nested: [1] } };
  expect(() => runReplayAction(replay, initial.seed, initial.unitSet)).toThrow('test');
});

it('AC-INT-22 아카이브 재생만 실행하지 않는 장수의 예턴 배열을 공유한다', () => {
  const initial = allRulesInitial();
  const replay = initialReplayState(initial);
  replay.turns[1]![1] = { commandKey: 'move', args: { cityKey: 2 }, explicit: false };
  replay.turns[2]![0] = { commandKey: 'move', args: { cityKey: 1 }, explicit: true };
  const original = structuredClone(replay);
  const normal = runReplayAction(replay, initial.seed, initial.unitSet);
  deepFreeze(replay.state);
  const archive = runArchiveReplayAction(replay, initial.seed, initial.unitSet, ruleRegistry);
  expect(archive).toEqual(normal);
  expect(replay).toEqual(original);
  expect(archive.state).not.toBe(replay.state);
  expect(archive.turns[2]).toBe(replay.turns[2]);
  expect(normal.turns[2]).not.toBe(replay.turns[2]);
});

it('순수 재생은 resolver를 전달하고 메서드 수신자를 보존한다', () => {
  const initial = allRulesInitial();
  const replay = initialReplayState(initial);
  replay.state.generals[1]!.userId = 'user';
  replay.residenceAnchors![1] = 0;
  replay.policy!.lastActiveTicks[1] = 0;
  const base = resolverForRuleFeatures(replay.state)!;
  const keys: string[] = [];
  const resolver = {
    ...base,
    run(...args: Parameters<typeof base.run>) {
      expect(this).toBe(resolver);
      keys.push(args[2]);
      return base.run(...args);
    },
  };
  const result = runReplayAction(replay, initial.seed, initial.unitSet, resolver);
  expect(keys.length).toBeGreaterThan(0);
  expect(result).toEqual(runReplayAction(replay, initial.seed, initial.unitSet));
});
