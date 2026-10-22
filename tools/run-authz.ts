import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appRouter } from '../apps/server/src/router';
import { evidenceFile } from '../apps/server/src/authz/case';
import { compareAuthz, type AuthzEvidence } from '../apps/server/src/authz/coverage';
import { exemptions } from '../apps/server/src/authz/exemptions';

mkdirSync(dirname(evidenceFile), { recursive: true });
writeFileSync(evidenceFile, '[]');
const result = spawnSync('pnpm', ['test:int'], { env: { ...process.env, AUTHZ_RECORD: '1' }, stdio: 'inherit' });
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
const evidence: AuthzEvidence[] = JSON.parse(readFileSync(evidenceFile, 'utf8'));
const report = compareAuthz(appRouter, evidence, exemptions);
for (const { path, type } of report.procedures) console.log(`API ${path} ${type}`);
for (const exemption of report.exempted) console.log(`EXEMPT ${exemption}`);
for (const missing of report.missing) console.error(`MISSING ${missing}`);
console.log(
  `AUTHZ procedures=${report.procedures.length} executed=${new Set(evidence.map(({ path, category }) => `${path}:${category}`)).size} exemptions=${report.exempted.length} missing=${report.missing.length}`,
);
if (report.missing.length) process.exit(1);
