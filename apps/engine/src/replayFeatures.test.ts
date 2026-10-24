import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  checkRuleFeatures,
  initialReplayStateWithRegistry,
  ruleRegistry,
  toWorldState,
  type ReplayOriginV3,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import {
  exportReplay,
  readArchive,
  replayArchive,
  replayToEnd,
  resourceHash,
  resourceHashV3,
  type ReplayArchiveV3,
} from './replay';
import { featureArchive, featureRegistry, asV3, exportDatabase } from '../test/replayFeaturesFixture';
import { unifiedArchive, rejectedInput } from '../test/replayFixture';

const baseline = async () =>
  JSON.parse(await readFile(new URL('../test/fixtures/replay-v2-53dd348.json', import.meta.url), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);
function rehash(archive: ReplayArchiveV3) {
  archive.origin.initialStateHash = hashState(archive.origin.initial);
  archive.origin.resourceHash = resourceHashV3(archive.origin);
  return archive;
}

describe('T2-26 형식과 기능 재생', () => {
  // PostgreSQL jsonb의 키 순서를 포함한 바이트 보존은 실제 DB 통합 시험에서 검사하고 단위 시험은 내용을 비교한다.
  it('53dd348 수출 내용과 형식 1 입력 키를 유지한다', async () => {
    const expected = await unifiedArchive(true);
    expected.afterEnd = [
      rejectedInput(expected.end!.sequence + 1),
      { ...rejectedInput(expected.end!.sequence + 2), kind: 'turns.set' },
    ];
    expect(await exportReplay(exportDatabase(expected).db, 'baseline')).toEqual(await baseline());
    expect(replayToEnd(expected)).toEqual(expected.end);
  });
  it('archive 3 고정 파일과 수출·종료 재생이 같다', async () => {
    const expected = asV3(await baseline());
    const saved = JSON.parse(await readFile(new URL('../test/fixtures/replay-v3.json', import.meta.url), 'utf8'));
    expect(await exportReplay(exportDatabase(expected).db, 'v3')).toEqual(saved);
    expect(replayToEnd(saved)).toEqual(saved.end);
  });
  it('기능 없는 형식 3은 12개월 형식 1 해시와 같다', async () => {
    const legacy = JSON.parse(
      await readFile(new URL('../test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    );
    const archive = {
      ...legacy,
      version: 3,
      origin: { ...legacy.origin, version: 3 },
      config: { endYear: null, outcomeFromSequence: 0 },
      end: null,
      afterEnd: [],
    };
    expect(replayArchive(archive)).toEqual(replayArchive(legacy));
    expect(resourceHashV3(archive.origin)).toBe(resourceHash(legacy.origin.initial));
    expect(hashState(initialReplayStateWithRegistry(archive.origin.initial, featureRegistry))).toBe(
      hashState(initialReplayStateWithRegistry(legacy.origin.initial, ruleRegistry)),
    );
    expect(toWorldState(archive.origin.initial)).not.toHaveProperty('ruleFeatures');
  });
  it('다섯 기능 조합을 12개월 재생하고 조합별 해시가 다르다', async () => {
    const hashes: string[] = [];
    for (const features of [[], ['test-a'], ['test-b'], ['test-a', 'test-b'], ['test-a', 'test-c']]) {
      const archive = await featureArchive(features);
      expect(replayArchive(archive, 12, featureRegistry)).toEqual(
        archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
      );
      hashes.push(archive.months.at(-1)!.stateHash);
    }
    expect(new Set(hashes).size).toBe(5);
  });
  it.each([
    [],
    null,
    'test-a',
    ['Test-a'],
    ['test-a', 'test-a'],
    ['test-b', 'test-a'],
    ['unknown'],
    ['test-c'],
    ['test-b', 'test-d'],
  ])('기능 목록 %j를 거부한다', (value) => {
    expect(() => checkRuleFeatures(value, featureRegistry)).toThrow();
  });
  it('기능 자료는 리소스 해시에만 더하고 생성 검사로 검증한다', async () => {
    const archive = await featureArchive(['test-a']);
    const old = archive.origin.resourceHash;
    archive.origin.featureData = { 'test-a': 'fixture' };
    rehash(archive);
    expect(archive.origin.resourceHash).not.toBe(old);
    expect(replayArchive(archive, 12, featureRegistry)).toHaveLength(12);
    archive.origin.featureData['test-a'] = 'wrong';
    expect(() => readArchive(archive, featureRegistry)).toThrow('자료');
  });
  it.each(['rejected', 'afterEnd', 'other', 'direct'])('F16은 %s 입력도 재생 전에 검사한다', async (target) => {
    const archive = await featureArchive(['test-a', 'test-b']);
    const input = { ...archive.inputs[1]!, payload: { value: '#' }, status: 'REJECTED' as const };
    if (target === 'afterEnd') {
      archive.end = {
        sequence: archive.months.at(-1)!.sequence + 1,
        tick: 120001,
        reason: 'UNIFIED',
        winnerNationId: 1,
        year: 191,
        month: 1,
        finalStateHash: 'unused',
      };
      archive.afterEnd = [{ ...input, sequence: archive.end.sequence + 1 }];
    } else if (target === 'other') archive.inputs[3]!.payload = { value: '#' };
    else if (target === 'direct') archive.inputs[0]!.payload = { value: '#' };
    else archive.inputs[1] = input;
    expect(() => replayArchive(archive, 1, featureRegistry)).toThrow('금지 문자');
    archive.origin.initial.ruleFeatures = ['test-b'];
    rehash(archive);
    archive.inputs = archive.inputs.map((i) => ({ ...i, status: 'REJECTED' }));
    expect(() => readArchive(archive, featureRegistry)).not.toThrow();
  });
  it.each([0, 2, 4, 5])('F1~F3 origin 또는 archive %s를 거부한다', async (version) => {
    const archive = await featureArchive([]);
    expect(() => readArchive({ ...archive, version })).toThrow();
    expect(() => readArchive({ ...archive, origin: { ...archive.origin, version } })).toThrow();
  });
  it('F2~F4는 옛 형식과 새 칸의 혼합을 거부한다', async () => {
    const archive = await baseline();
    expect(() => readArchive({ ...archive, origin: { ...archive.origin, version: 3 } })).toThrow();
    expect(() => readArchive({ ...archive, version: 3 })).toThrow();
    expect(() =>
      readArchive({
        ...archive,
        origin: { ...archive.origin, initial: { ...archive.origin.initial, ruleFeatures: [] } },
      }),
    ).toThrow();
    expect(() => readArchive({ ...archive, origin: { ...archive.origin, featureData: {} } })).toThrow();
    for (const key of ['inputs', 'afterEnd']) {
      const bad = clone(archive);
      bad[key][0].tick = null;
      expect(() => readArchive(bad)).toThrow('tick');
    }
    archive.inputs[0].status = 'REJECTED';
    archive.inputs[0].kind = 'old-unknown';
    expect(() => readArchive(archive)).not.toThrow();
  });
  it.each(['extra', 'version', 'initial', 'initialStateHash', 'resourceHash', 'featureData'])(
    'F5는 origin의 %s 칸을 검사한다',
    async (key) => {
      const archive = await featureArchive([]);
      const origin = archive.origin as unknown as Record<string, unknown>;
      if (key === 'extra') origin.extra = true;
      else if (key === 'featureData') origin.featureData = {};
      else delete origin[key];
      expect(() => readArchive(archive, featureRegistry)).toThrow();
    },
  );
  it('F6~F9는 초기 기능·의존·자료 키를 검사한다', async () => {
    const archive = await featureArchive([]);
    for (const features of [[], ['test-b', 'test-a'], ['test-c'], ['test-b', 'test-d'], ['unknown']]) {
      const bad = clone(archive);
      bad.origin.initial.ruleFeatures = features;
      rehash(bad);
      expect(() => readArchive(bad, featureRegistry)).toThrow();
    }
    archive.origin.featureData = { 'test-a': 'fixture' };
    rehash(archive);
    expect(() => readArchive(archive, featureRegistry)).toThrow('자료');
  });
  it.each(['initialStateHash', 'resourceHash'])('F10은 %s 변조를 거부한다', async (key) => {
    const archive = await featureArchive([]);
    archive.origin[key as keyof Pick<ReplayOriginV3, 'initialStateHash' | 'resourceHash'>] = 'bad';
    expect(() => readArchive(archive)).toThrow('해시');
  });
  it.each(['config', 'end', 'afterEnd'])('F11은 %s 누락을 거부한다', async (key) => {
    const archive = await featureArchive([]);
    delete (archive as unknown as Record<string, unknown>)[key];
    expect(() => readArchive(archive)).toThrow();
  });
  it('F12~F14는 거부 입력까지 종류·tick을 검사한다', async () => {
    const source = await featureArchive(['test-a']);
    for (const input of [
      { ...source.inputs[1]!, tick: undefined },
      { ...source.inputs[1]!, tick: -1 },
      { ...source.inputs[1]!, tick: 0.5 },
      { ...source.inputs[1]!, tick: Number.MAX_SAFE_INTEGER + 1 },
      { ...source.inputs[0]!, tick: 0 },
      { ...source.inputs[1]!, kind: 'unknown', status: 'REJECTED' as const },
    ]) {
      const archive = clone(source);
      archive.inputs[input.sequence - 1] = input as ReplayArchiveV3['inputs'][number];
      expect(() => readArchive(archive, featureRegistry)).toThrow();
    }
    const missing = clone(source);
    delete (missing.inputs[1] as Partial<ReplayArchiveV3['inputs'][number]>).tick;
    expect(() => readArchive(missing, featureRegistry)).toThrow('tick');
    delete source.origin.initial.ruleFeatures;
    rehash(source);
    expect(() => readArchive(source, featureRegistry)).toThrow('켜지');
    source.inputs = source.inputs.map((input) => ({ ...input, status: 'REJECTED' }));
    expect(() => readArchive(source, featureRegistry)).not.toThrow();
  });
  it.each([false, true])('F15는 APPLIED·REJECTED 입력 창을 확인한다. 거부: %s', async (rejected) => {
    const archive = await featureArchive(['test-a']);
    archive.inputs[1]!.tick = 10000;
    if (rejected) archive.inputs[1]!.status = 'REJECTED';
    expect(() => replayArchive(archive, 1, featureRegistry)).toThrow('월 창');
    const ended = asV3(await baseline());
    ended.inputs[1]!.tick = 9999;
    expect(() => replayToEnd(ended)).toThrow('월 창');
  });
  it('F12·F13은 afterEnd에도 적용한다', async () => {
    const archive = asV3(await baseline());
    archive.afterEnd[0]!.tick = null;
    expect(() => readArchive(archive)).toThrow('tick');
    archive.afterEnd[0]!.tick = 0;
    archive.afterEnd[0]!.kind = 'unknown';
    expect(() => readArchive(archive)).toThrow('종류');
  });
});
