// pnpm lint:text [--strict] [경로...]
// 글쓰기 규칙(docs/writing-style.md)의 S1 패턴을 찾는다. 기본은 경고만, --strict면 1건이라도 있으면 실패한다.
// 종료 코드: 0 통과(또는 경고만), 1 --strict에서 걸린 곳 있음, 2 사용 오류
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinding, lintSource, RULE_IDS, type Finding } from './lint-text';
import { collectTargets, type Target } from './targets';

const USAGE = '사용법: pnpm lint:text [--strict] [경로...]';

interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function main(args: readonly string[], root: string, io: Io = console): number {
  const strict = args.includes('--strict');
  const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--strict');
  if (unknown.length > 0) {
    io.error(`알 수 없는 옵션: ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  const paths = args.filter((arg) => !arg.startsWith('-'));

  let targets: Target[];
  try {
    targets = collectTargets(root, paths);
  } catch (error) {
    io.error((error as Error).message);
    return 2;
  }

  const findings: Finding[] = [];
  for (const target of targets) {
    const source = readFileSync(join(root, target.path), 'utf8');
    findings.push(...lintSource({ ...target, source }));
  }
  for (const finding of findings) io.log(formatFinding(finding));

  const byRule = RULE_IDS.map((id) => [id, findings.filter((finding) => finding.id === id).length] as const)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id} ${count}`)
    .join(', ');
  const files = new Set(findings.map((finding) => finding.path)).size;
  io.log(
    findings.length === 0
      ? `문구 검사: 파일 ${targets.length}개에서 걸린 곳 없음`
      : `문구 검사: 파일 ${targets.length}개 중 ${files}개에서 ${findings.length}건 (${byRule})`,
  );
  return strict && findings.length > 0 ? 1 : 0;
}

const script = process.argv[1];
if (script && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
