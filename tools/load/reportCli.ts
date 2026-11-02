import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readLoadReport } from './reportFiles';

export async function reportMain(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error('사용법: pnpm load:report .load-reports/<runId>');
    return 2;
  }
  const report = await readLoadReport(args[0]);
  console.log(JSON.stringify(report, null, 2));
  return report.verdict === 'PASS' || report.verdict === 'SMOKE_ONLY' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await reportMain(process.argv.slice(2));
