import { z } from 'zod';
import type { RuleFeatureDefinition } from '../ruleRegistry';
import type { WorldInit } from '../world/bootstrap';

export const RELATIONS_FEATURE = 'relations-v1';
const scenarioKey = '1030';
const general = z.strictObject({ id: z.number().int().positive(), name: z.string().min(1) });
const pair = z.strictObject({
  a: general,
  b: general,
  kind: z.enum(['kin', 'sworn', 'lord']),
  ref: z.string().regex(/^[HJK][1-9][0-9]?$/),
});
const relationsSchema = z.strictObject({ version: z.literal(1), pairs: z.array(pair).min(1).max(1000) });
export type RelationsData = z.infer<typeof relationsSchema>;

// 출처와 관계의 근거는 docs/plans/T4-42.md 4절의 같은 행 번호를 따른다.
const historicalPairs = [
  [47, '관우', 50, '관평', 'kin', 'H12'],
  [47, '관우', 281, '유비', 'sworn', 'J1'],
  [94, '마등', 100, '마초', 'kin', 'H10'],
  [167, '손견', 181, '손책', 'kin', 'H8'],
  [169, '손권', 181, '손책', 'kin', 'H9'],
  [181, '손책', 408, '주유', 'sworn', 'J4'],
  [266, '원담', 268, '원소', 'kin', 'H5'],
  [267, '원상', 268, '원소', 'kin', 'H7'],
  [268, '원소', 269, '원술', 'kin', 'H4'],
  [268, '원소', 271, '원희', 'kin', 'H6'],
  [281, '유비', 322, '장비', 'sworn', 'J2'],
  [281, '유비', 370, '제갈량', 'lord', 'K1'],
  [281, '유비', 389, '조운', 'lord', 'K2'],
  [286, '유언', 290, '유장', 'kin', 'H11'],
  [369, '제갈근', 370, '제갈량', 'kin', 'H13'],
  [381, '조비', 392, '조조', 'kin', 'H3'],
  [391, '조인', 392, '조조', 'kin', 'H1'],
  [449, '하후돈', 452, '하후연', 'kin', 'H2'],
] as const;

export function readRelationsData(initial: Pick<WorldInit, 'scenarioKey' | 'generals'>, value: unknown): RelationsData {
  if (initial.scenarioKey !== scenarioKey) throw new Error('관계 자료의 게시 시나리오 판이 다릅니다.');
  const data = relationsSchema.parse(value);
  const names = new Map(initial.generals.map(({ id, name }) => [id, name]));
  const refs = new Set<string>();
  let lastA = 0;
  let lastB = 0;
  for (const { a, b, ref } of data.pairs) {
    if (a.id >= b.id || a.id < lastA || (a.id === lastA && b.id <= lastB) || refs.has(ref))
      throw new Error('관계 자료의 순서나 중복을 확인하세요.');
    if (names.get(a.id) !== a.name || names.get(b.id) !== b.name) throw new Error('관계 자료와 생성 장수가 다릅니다.');
    lastA = a.id;
    lastB = b.id;
    refs.add(ref);
  }
  return data;
}

export function createRelationsData(initial: Pick<WorldInit, 'scenarioKey' | 'generals'>): RelationsData {
  const pairs = historicalPairs.map(([a, nameA, b, nameB, kind, ref]) => ({
    a: { id: a, name: nameA },
    b: { id: b, name: nameB },
    kind,
    ref,
  }));
  return readRelationsData(initial, { version: 1, pairs });
}

export const relationsFeature: RuleFeatureDefinition = {
  key: RELATIONS_FEATURE,
  requires: [],
  conflicts: [],
  checkOrigin({ initial, data }) {
    readRelationsData(initial, data);
  },
  initReplayState(replay, { initial, data }) {
    return { ...replay, state: { ...replay.state, relations: readRelationsData(initial, data) } };
  },
};
