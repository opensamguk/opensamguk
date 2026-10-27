import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fiveStatsSchema } from '../../packages/rules/src/general/fiveStats';

const text = z.string().min(1);
const positive = z.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRow = z.strictObject({
  officerId: positive,
  name: text,
  identity: text,
  birthYear: z.number().int(),
  deathYear: z.number().int(),
  sourceId: text,
  sourceRevision: text,
  stats: fiveStatsSchema,
});
export const sourcesSchema = z.strictObject({
  sourceCommit: z.literal('bc053629710711d4c5dfa50683bae78f4baeca95'),
  sourcePath: z.literal('resources/scenario/scenario_3190.json'),
  originalSha256: z.literal('e4bc491e14733b46a45606273a7bc3a6dd3bc4082e96eb057a2fc00b83cae1c3'),
  originalCount: z.literal(1000),
  rows: z.array(sourceRow).length(483),
});
const rowSchema = z.strictObject({
  generalId: positive,
  name: text,
  identity: text,
  officerId: positive,
  sourceId: text,
  sourceRevision: text,
  stats: fiveStatsSchema,
  evidence: z.strictObject({
    kind: z.enum(['v1-officer-id', 'published-game-data', 'user-adopted-fan-data']),
    note: text,
    urls: z.array(z.url()).min(1),
    approval: text.optional(),
  }),
});
export const ledgerSchema = z.strictObject({
  version: z.literal(1),
  scenario: z.literal('1030'),
  startYear: z.literal(191),
  mainCommit: z.literal('7b910312549062ad670e203015c020e13bbf6518'),
  mainSha256: sha256,
  sourceSnapshotSha256: sha256,
  review: z.strictObject({
    status: z.enum(['pending', 'approved']),
    reviewer: text.optional(),
    evidence: text.optional(),
    contentSha256: sha256.optional(),
  }),
  rows: z.array(rowSchema).length(491),
});
export type OfficerLedger = z.infer<typeof ledgerSchema>;
export type OfficerSources = z.infer<typeof sourcesSchema>;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Selected facts and their URL, not a digest of the third-party page's HTML. */
export function supplementalRevision(identity: string, stats: z.infer<typeof fiveStatsSchema>, url: string): string {
  return `sha256:${sha256Text(JSON.stringify({ identity, stats: fiveStatsSchema.parse(stats), url }))}`;
}

export function officerContentHash(ledger: OfficerLedger): string {
  const { version, scenario, startYear, mainCommit, mainSha256, sourceSnapshotSha256, rows } = ledger;
  const content = { version, scenario, startYear, mainCommit, mainSha256, sourceSnapshotSha256, rows };
  return sha256Text(JSON.stringify(content));
}

/** This adapter alone accepts the v1 spelling; the published contract always uses intel. */
export function adaptOfficerStats(value: unknown) {
  const { intelligence, ...other } = z
    .strictObject({
      leadership: z.number(),
      strength: z.number(),
      intelligence: z.number(),
      politics: z.number(),
      charm: z.number(),
    })
    .parse(value);
  return fiveStatsSchema.parse({ ...other, intel: intelligence });
}

export function auditOfficerLedger(mainText: string, sourcesText: string, ledgerValue: unknown, requireReview = true) {
  const sources = sourcesSchema.parse(JSON.parse(sourcesText));
  const ledger = ledgerSchema.parse(ledgerValue);
  if (sha256Text(mainText) !== ledger.mainSha256) throw new Error('main 시나리오 원문이 기준과 다릅니다.');
  if (sha256Text(sourcesText) !== ledger.sourceSnapshotSha256) throw new Error('능력치 출처 사본이 바뀌었습니다.');
  const main = JSON.parse(mainText) as { startYear: number; nation: unknown[]; general: unknown[][] };
  if (main.startYear !== 191 || main.nation.length !== 21 || main.general.length !== 491)
    throw new Error('191년·21국·491장수 기준이 아닙니다.');
  const sourceById = new Map(sources.rows.map((row) => [row.officerId, row]));
  if (sourceById.size !== sources.rows.length) throw new Error('출처 인물 ID가 중복됐습니다.');
  const seen = new Set<string>();
  let sourceCount = 0;
  for (const [index, row] of ledger.rows.entries()) {
    if (row.generalId !== index + 1 || row.name !== main.general[index]?.[1])
      throw new Error(`main 장수 ID·이름·순서가 다릅니다: ${index + 1}`);
    const key = `${row.sourceId}/${row.officerId}`;
    if (seen.has(key)) throw new Error(`같은 출처 인물을 중복 대응했습니다: ${row.name}`);
    seen.add(key);
    if (row.evidence.kind === 'v1-officer-id') {
      const source = sourceById.get(row.officerId);
      if (
        !source ||
        source.identity !== row.identity ||
        source.sourceId !== row.sourceId ||
        source.sourceRevision !== row.sourceRevision ||
        JSON.stringify(source.stats) !== JSON.stringify(row.stats)
      )
        throw new Error(`출처와 능력치·인물 ID가 다릅니다: ${row.name}`);
      sourceCount++;
    } else if (sourceById.has(row.officerId)) {
      throw new Error(`보충 출처가 기존 인물 ID를 재사용했습니다: ${row.name}`);
    } else if (row.sourceRevision !== supplementalRevision(row.identity, row.stats, row.evidence.urls[0]!)) {
      throw new Error(`보충 출처의 선택 사실 해시가 다릅니다: ${row.name}`);
    }
    if (row.evidence.kind === 'user-adopted-fan-data' && !row.evidence.approval)
      throw new Error(`팬 제작값의 사용자 확정 근거가 없습니다: ${row.name}`);
  }
  if (sourceCount !== 483) throw new Error('v1에서 확인한 483명 대응이 모두 필요합니다.');
  if (
    requireReview &&
    (ledger.review.status !== 'approved' ||
      !ledger.review.reviewer ||
      !ledger.review.evidence ||
      ledger.review.contentSha256 !== officerContentHash(ledger))
  )
    throw new Error('현재 원장 내용의 독립 리뷰가 필요합니다.');
  return ledger.rows.map(({ generalId, officerId, sourceId, sourceRevision, stats }) => ({
    generalId,
    officerId,
    sourceId,
    sourceRevision,
    stats,
  }));
}
