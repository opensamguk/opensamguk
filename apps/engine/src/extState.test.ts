import { readFileSync } from 'node:fs';
import type { Prisma } from '@opensamguk/db';
import {
  commands,
  initialReplayState,
  runGeneralTurn,
  runReplayAction,
  type WorldInit,
  type WorldPreset,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import { engineResolver, loadExt, persistExt, verifyWorldExt } from './extState';

const preset = JSON.parse(
  readFileSync(new URL('../../../resources/preset/regular.json', import.meta.url), 'utf8'),
) as WorldPreset;
const initial = (
  JSON.parse(readFileSync(new URL('../test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8')) as {
    origin: { initial: WorldInit };
  }
).origin.initial;

function transaction(rows: { key: string; value: unknown }[] = []) {
  const read = vi.fn().mockResolvedValue(rows);
  const write = vi.fn().mockResolvedValue(1);
  return { tx: { $queryRaw: read, $executeRaw: write } as unknown as Prisma.TransactionClient, read, write };
}

it.each([null, preset])('1a-off는 기본 37개 명령과 목록 순서를 보존한다 (%#)', (value) => {
  const selection = engineResolver({ preset: value });
  expect(selection.commands).toBeNull();
  expect(selection.resolver.list('general')).toEqual(commands.filter((def) => def.target === 'general'));
  expect(selection.resolver.list('nation')).toEqual(commands.filter((def) => def.target === 'nation'));
  expect([...selection.resolver.list('general'), ...selection.resolver.list('nation')]).toHaveLength(37);
});

it('등록된 무상태 계략도 1a-off 생성·적재 대상으로 받지 않는다', async () => {
  const enabled = { ...preset, commands: { general: ['fire_attack'], nation: [] } };
  const { tx, read, write } = transaction();
  expect(() => engineResolver({ preset: enabled })).toThrow('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  await expect(verifyWorldExt(tx, { id: 'off', preset: enabled })).rejects.toThrow(
    '확장 명령을 켠 월드는 아직 지원하지 않습니다.',
  );
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('선택 대조를 마친 무상태 확장은 빈 행만 복원한다', async () => {
  const commands = { general: ['fire_attack'], nation: [] };
  const empty = transaction();
  expect(await loadExt(empty.tx, 'ext', commands)).toBeUndefined();
  const orphan = transaction([{ key: 'orphan', value: null }]);
  await expect(loadExt(orphan.tx, 'ext', commands)).rejects.toThrow();
  expect(orphan.write).not.toHaveBeenCalled();
});

it('끈 월드의 빈 행은 ext 키를 만들지 않고 남는 조각은 실제 복원 함수가 거부한다', async () => {
  const empty = transaction();
  expect(await loadExt(empty.tx, 'off', null)).toBeUndefined();
  const orphan = transaction([{ key: 'orphan', value: null }]);
  await expect(verifyWorldExt(orphan.tx, { id: 'off', preset: null })).rejects.toThrow();
  expect(orphan.read).toHaveBeenCalledOnce();
  expect(orphan.write).not.toHaveBeenCalled();
});

it('끈 월드 저장은 SQL을 내지 않고 before·next 불일치는 쓰기 전에 거부한다', async () => {
  const { tx, read, write } = transaction();
  await persistExt(tx, 'off', undefined, undefined);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await expect(persistExt(tx, 'off', { orphan: null }, undefined)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it.each([true, false])('기존 options와 explicit=%s에서 resolver 추가 전후 턴 결과·해시가 같다', (explicit) => {
  const state = initialReplayState(initial).state;
  const actor = Object.values(state.generals)[0]!;
  actor.userId = 'unit-user';
  const city = state.cities[actor.cityKey]!;
  city.agriculture = 0;
  const command = { commandKey: 'rest', args: {}, explicit };
  const context = { generalId: actor.id, tick: actor.nextTurnTick, unitSet: initial.unitSet };
  const options = { policy: 'farm' as const };
  const before = structuredClone(state);
  const direct = runGeneralTurn(state, context, command, initial.seed, options);
  const resolved = runGeneralTurn(
    state,
    context,
    command,
    initial.seed,
    options,
    engineResolver({ preset: null }).resolver,
  );
  expect(resolved).toEqual(direct);
  expect(hashState(resolved.state)).toBe(hashState(direct.state));
  expect(resolved.commandKey).toBe(explicit ? 'rest' : 'farm');
  expect(Object.hasOwn(resolved.state, 'ext')).toBe(false);
  expect(state).toEqual(before);
});

it('기존 재생의 넷째 resolver 자리는 상태·RNG 결과를 보존한다', () => {
  let direct = initialReplayState(initial);
  let resolved = initialReplayState(initial);
  const resolver = engineResolver({ preset: null }).resolver;
  for (let step = 0; step < 48; step++) {
    direct = runReplayAction(direct, initial.seed, initial.unitSet);
    resolved = runReplayAction(resolved, initial.seed, initial.unitSet, resolver);
    expect(resolved).toEqual(direct);
    expect(hashState(resolved)).toBe(hashState(direct));
    expect(Object.hasOwn(resolved.state, 'ext')).toBe(false);
  }
});
