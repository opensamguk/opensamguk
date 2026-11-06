import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { categories } from '../apps/server/src/authz/coverage';
import { AUTHZ_SHARD_TOTAL, integrationPartition } from './integration-partition';
import { pnpmCli } from './node-cli';

const shardSchema = z.strictObject({
  index: z.int().min(1).max(AUTHZ_SHARD_TOTAL),
  total: z.literal(AUTHZ_SHARD_TOTAL),
});
const recordSchema = z.strictObject({
  schema: z.literal('opensamguk-authz-shard/1'),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^\d+$/),
  runAttempt: z.string().regex(/^\d+$/),
  suite: z.literal('api'),
  shard: shardSchema,
  vitest: z.strictObject({
    success: z.literal(true),
    files: z.array(z.string().regex(/^(?:apps|tools)\/[^\\]+\.integration\.test\.ts$/)).min(1),
  }),
  evidence: z.array(z.strictObject({ path: z.string().min(1), category: z.enum(categories) })),
});
export type AuthzShardRecord = z.infer<typeof recordSchema>;

export function parseAuthzArgs(args: string[]) {
  if (!args.length) return { mode: 'full' } as const;
  if (args.length === 2 && args[0] === '--merge' && isAbsolute(args[1]!))
    return { mode: 'merge', directory: args[1]! } as const;
  if (args.length === 4 && args[0] === '--shard' && args[2] === '--out' && isAbsolute(args[3]!)) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(args[1]!);
    const parsed = shardSchema.safeParse({ index: Number(match?.[1]), total: Number(match?.[2]) });
    if (parsed.success) return { mode: 'shard', shard: parsed.data, output: args[3]! } as const;
  }
  throw new Error('authz usage');
}

function repositoryFile(root: string, file: string) {
  if (!isAbsolute(file)) throw new Error('authz report-path');
  const path = relative(root, file).split(sep).join('/');
  if (path.split('/').some((part) => part === '..' || part === '.') || isAbsolute(path))
    throw new Error('authz report-path');
  return path;
}

export function buildShardRecord(
  input: Omit<AuthzShardRecord, 'schema' | 'vitest'>,
  vitestJson: unknown,
  root: string,
) {
  const report = z
    .object({
      success: z.literal(true),
      testResults: z.array(z.object({ name: z.string(), status: z.literal('passed') })).min(1),
    })
    .safeParse(vitestJson);
  if (!report.success) throw new Error('authz vitest-failed');
  const parsed = recordSchema.safeParse({
    ...input,
    schema: 'opensamguk-authz-shard/1',
    vitest: { success: true, files: report.data.testResults.map(({ name }) => repositoryFile(root, name)) },
  });
  if (!parsed.success) throw new Error('authz record-schema');
  return parsed.data;
}

export function readShardDir(directory: string): unknown[] {
  const directories = readdirSync(directory, { withFileTypes: true });
  if (directories.length !== AUTHZ_SHARD_TOTAL) throw new Error('authz artifact-layout');
  return directories.map((entry) => {
    if (!entry.isDirectory()) throw new Error('authz artifact-layout');
    const files = readdirSync(join(directory, entry.name));
    if (files.length !== 1 || files[0] !== 'record.json') throw new Error('authz artifact-layout');
    const parsed = recordSchema.safeParse(JSON.parse(readFileSync(join(directory, entry.name, 'record.json'), 'utf8')));
    if (
      !parsed.success ||
      entry.name !== `authz-evidence-${parsed.data.sha}-shard-${parsed.data.shard.index}-of-${AUTHZ_SHARD_TOTAL}`
    )
      throw new Error('authz artifact-layout');
    return parsed.data;
  });
}

export function mergeShardRecords(
  records: unknown[],
  expected: { sha: string; runId: string; shardsResult: string; files: string[] },
) {
  if (expected.shardsResult !== 'success') throw new Error('authz shards-result');
  if (!/^[a-f0-9]{40}$/.test(expected.sha) || !/^\d+$/.test(expected.runId)) throw new Error('authz identity');
  if (!expected.files.length || new Set(expected.files).size !== expected.files.length)
    throw new Error('authz expected-files');
  const indices = new Set<number>(),
    files = new Set<string>();
  const evidence: AuthzShardRecord['evidence'] = [];
  for (const raw of records) {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) throw new Error('authz record-schema');
    const record = parsed.data;
    if (record.sha !== expected.sha || record.runId !== expected.runId) throw new Error('authz identity');
    if (indices.has(record.shard.index)) throw new Error('authz shard-duplicate');
    indices.add(record.shard.index);
    for (const file of record.vitest.files) {
      if (files.has(file)) throw new Error('authz file-overlap');
      files.add(file);
    }
    evidence.push(...record.evidence);
  }
  if (indices.size !== AUTHZ_SHARD_TOTAL) throw new Error('authz shard-missing');
  if (files.size !== expected.files.length || expected.files.some((file) => !files.has(file)))
    throw new Error('authz file-union');
  return evidence;
}

export function expectedApiFiles(root: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    ...pnpmCli(
      [
        'exec',
        'vitest',
        'list',
        '--filesOnly',
        '--json',
        '--config',
        'vitest.integration.config.ts',
        ...integrationPartition('api'),
      ],
      env,
    ),
    { cwd: root, env, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) throw new Error('authz expected-files');
  const parsed = z
    .array(z.object({ file: z.string() }))
    .min(1)
    .safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new Error('authz expected-files');
  return parsed.data.map(({ file }) => repositoryFile(root, file)).sort();
}
