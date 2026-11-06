import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appRouter } from '../apps/server/src/router';
import { evidenceFile } from '../apps/server/src/authz/case';
import { compareAuthz, type AuthzEvidence } from '../apps/server/src/authz/coverage';
import { exemptions } from '../apps/server/src/authz/exemptions';
import { pnpmCli } from './node-cli';
import { buildShardRecord, expectedApiFiles, mergeShardRecords, parseAuthzArgs, readShardDir } from './authz-shards';

function reportEvidence(evidence: AuthzEvidence[]) {
  const report = compareAuthz(appRouter, evidence, exemptions);
  for (const { path, type } of report.procedures) console.log(`API ${path} ${type}`);
  for (const exemption of report.exempted) console.log(`EXEMPT ${exemption}`);
  for (const missing of report.missing) console.error(`MISSING ${missing}`);
  console.log(
    `AUTHZ procedures=${report.procedures.length} executed=${new Set(evidence.map(({ path, category }) => `${path}:${category}`)).size} exemptions=${report.exempted.length} missing=${report.missing.length}`,
  );
  if (report.missing.length) process.exit(1);
}

const args = parseAuthzArgs(process.argv.slice(2));
if (args.mode !== 'full') {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (
    head.status !== 0 ||
    !/^[a-f0-9]{40}$/.test(process.env.AUTHZ_EXPECTED_SHA ?? '') ||
    head.stdout.trim() !== process.env.AUTHZ_EXPECTED_SHA
  )
    throw new Error('authz source SHA');
}
if (args.mode === 'merge') {
  reportEvidence(
    mergeShardRecords(readShardDir(args.directory), {
      sha: process.env.AUTHZ_EXPECTED_SHA!,
      runId: process.env.GITHUB_RUN_ID ?? '',
      shardsResult: process.env.AUTHZ_SHARDS_RESULT ?? '',
      files: expectedApiFiles(process.cwd()),
    }),
  );
} else {
  const env: NodeJS.ProcessEnv = { ...process.env, AUTHZ_RECORD: '1' };
  let reportFile: string | undefined;
  if (args.mode === 'shard') {
    if (
      env.INTEGRATION_SUITE !== 'api' ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    )
      throw new Error('authz shard identity');
    mkdirSync(dirname(args.output), { recursive: true });
    reportFile = join(dirname(args.output), 'vitest.json');
    if (reportFile === args.output) throw new Error('authz output collision');
    rmSync(args.output, { force: true });
    rmSync(reportFile, { force: true });
    Object.assign(env, {
      INTEGRATION_SHARD: `${args.shard.index}/${args.shard.total}`,
      INTEGRATION_REPORT: reportFile,
    });
  }
  mkdirSync(dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, '[]');
  const result = spawnSync(...pnpmCli(['test:int']), { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
  const evidence: AuthzEvidence[] = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  if (args.mode === 'shard') {
    const record = buildShardRecord(
      {
        sha: env.AUTHZ_EXPECTED_SHA!,
        runId: env.GITHUB_RUN_ID!,
        runAttempt: env.GITHUB_RUN_ATTEMPT!,
        suite: 'api',
        shard: args.shard,
        evidence,
      },
      JSON.parse(readFileSync(reportFile!, 'utf8')),
      process.cwd(),
    );
    writeFileSync(args.output, JSON.stringify(record));
    console.log(
      `AUTHZ shard ${args.shard.index}/${args.shard.total} recorded=${evidence.length} files=${record.vitest.files.length} (global comparison runs in opensamguk-database-authz)`,
    );
  } else reportEvidence(evidence);
}
