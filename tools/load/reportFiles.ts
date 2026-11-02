import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateLoadRun, loadRunSchema } from './report';

export async function readLoadReport(directory: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // SyntaxError의 입력 조각이나 원본 파일 경로를 출력하지 않는다.
    return { verdict: 'INVALID' as const, invalid: ['RAW_FILE_UNREADABLE'], failed: [] as string[] };
  }
  return evaluateLoadRun(raw);
}

export async function saveLoadReport(directory: string, raw: unknown) {
  const parsed = loadRunSchema.safeParse(raw);
  if (!parsed.success) throw new Error('LOAD_REPORT_SCHEMA_INVALID');
  const report = evaluateLoadRun(parsed.data);
  // 실행 담당이 만든 자기 디렉터리만 받으며 기존 증거는 덮어쓰지 않는다.
  await writeFile(join(directory, 'run.json'), JSON.stringify(parsed.data) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
