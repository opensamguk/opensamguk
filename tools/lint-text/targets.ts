// 문구 검사 대상 파일 고르기 (T1-25). 범위: docs/plans/T1-25.md
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SourceKind } from './lint-text';

export interface Target {
  /** 저장소 루트 기준 경로, 구분자는 / */
  path: string;
  kind: SourceKind;
  koreanOnly: boolean;
}

/** 경로를 주지 않았을 때 보는 곳 */
export const DEFAULT_PATHS = [
  'docs',
  'AGENTS.md',
  'README.md',
  'apps/web/src',
  'packages/rules/src',
  'apps/server/src',
];

/** 문자열·JSX 텍스트를 보는 코드 폴더. web은 모든 문자열, 나머지는 한글이 든 문자열만 본다. */
const CODE_ROOTS = [
  { root: 'apps/web/src/', koreanOnly: false },
  { root: 'packages/rules/src/', koreanOnly: true },
  { root: 'apps/server/src/', koreanOnly: true },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git']);
const TEST_FILE = /\.(?:test|spec|integration\.test)\.tsx?$/;

export function classify(path: string): Target | null {
  if (path === 'private' || path.startsWith('private/')) return null;
  if (path.endsWith('.md')) {
    if (path.startsWith('docs/') || path === 'AGENTS.md' || path === 'README.md') {
      return { path, kind: 'markdown', koreanOnly: false };
    }
    return null;
  }
  if (!/\.tsx?$/.test(path) || path.endsWith('.d.ts') || TEST_FILE.test(path)) return null;
  const code = CODE_ROOTS.find(({ root }) => path.startsWith(root));
  return code ? { path, kind: 'code', koreanOnly: code.koreanOnly } : null;
}

function walk(root: string, path: string, out: string[]) {
  const absolute = join(root, path);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new Error(`경로가 없습니다: ${path}`);
  }
  if (stat.isFile()) {
    out.push(path);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

/** 경로를 주지 않으면 DEFAULT_PATHS 중 있는 것만 본다. 경로를 주었는데 없으면 오류다. */
export function collectTargets(root: string, paths?: readonly string[]): Target[] {
  const files: string[] = [];
  const given = paths !== undefined && paths.length > 0;
  for (const path of given ? paths : DEFAULT_PATHS) {
    const normalized = relative(root, join(root, path)).split(sep).join('/') || '.';
    if (normalized.startsWith('..')) throw new Error(`저장소 밖 경로는 검사하지 않습니다: ${path}`);
    if (normalized === 'private' || normalized.startsWith('private/')) continue;
    if (!given && !existsSync(join(root, normalized))) continue;
    walk(root, normalized === '.' ? '' : normalized, files);
  }
  const unique = [...new Set(files.map((file) => file.split(sep).join('/')))].sort();
  return unique.map(classify).filter((target): target is Target => target !== null);
}
