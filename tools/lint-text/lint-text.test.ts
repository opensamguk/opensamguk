import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintSource, RULE_IDS, type RuleId } from './lint-text';
import { main } from './cli';
import { classify, collectTargets } from './targets';

const md = (source: string) => lintSource({ path: 'doc.md', source, kind: 'markdown' });
const code = (source: string, path = 'a.tsx', koreanOnly = false) =>
  lintSource({ path, source, kind: 'code', koreanOnly });
const ids = (findings: { id: RuleId }[]) => findings.map((finding) => finding.id);

describe('AC-M1-22 T1-25 문구 검사: 항목별 걸리는 예와 안 걸리는 예', () => {
  const cases: { id: RuleId; bad: string; good: string }[] = [
    { id: 'A-7', bad: '장수는 강한 무력을 가지고 있다.', good: '장수는 무력이 강하다. 칼을 가지고 갔다.' },
    { id: 'A-8', bad: '결과는 로그에 기록되어진다.', good: '결과는 로그에 기록된다. 돼지를 키운다.' },
    { id: 'C-5', bad: '## 🚀 시작하기', good: '## 시작하기 → 다음 ▶ 화살표와 © 기호는 글자다' },
    {
      id: 'C-10',
      bad: '## 결정: 턴 배치\n\n본문\n\n## 결정: 실행권',
      good: '## 결정: 턴 배치\n\n## 1. 범위: 첫 절\n\n## D-017: 번호 절\n\n## (3) 괄호: 번호\n\n## 제2장 전투: 야전',
    },
    {
      id: 'C-11',
      bad: '자원을 모으고, 군사를 키운다. 빠르지만, 약하다.',
      good: '자원을 모으고 군사를 키운다. 광고, 참고, 선전포고, 최고는 명사다.',
    },
    {
      id: 'D-1',
      bad: '따라서 A다. 그러므로 B다. 결론적으로 C다. 요약하면 D다.',
      good: '따라서 A다. 그러므로 B다. 결론적으로 C다. 규칙에 따라서 D다.',
    },
    { id: 'D-2', bad: '이 결과는 시사하는 바가 크다.', good: '이 결과로 병력이 30% 줄었다. 시사점은 없다.' },
    { id: 'D-3', bad: '명령은 크게 세 가지로 나눌 수 있다.', good: '명령은 내정, 군사, 인사로 나뉜다.' },
    {
      id: 'J-2',
      bad: '"신의"와 "대치"와 "작전"과 "보급"과 "기세"를 본다.',
      good: '"신의"와 "대치"와 "작전"과 "보급"을 본다. 조조는 "가자"라고 말했다. 그에 따르면 "곧 끝난다".',
    },
  ];

  it('검사 항목은 계획의 9개다', () => {
    expect([...RULE_IDS].sort()).toEqual(cases.map((c) => c.id).sort());
  });

  for (const { id, bad, good } of cases) {
    it(`${id}: 걸리는 예`, () => {
      expect(ids(md(bad))).toContain(id);
    });
    it(`${id}: 안 걸리는 예`, () => {
      expect(ids(md(good))).not.toContain(id);
    });
  }

  it('C-10은 ID 뒤에 라벨이 붙은 콜론 부제를 본다', () => {
    expect(ids(md('# T1-05 규칙 코어: 모델\n\n## 결정: 턴'))).toEqual(['C-10', 'C-10']);
  });

  it('J-2는 문서당 5회부터, D-1은 4회부터 걸린다', () => {
    expect(ids(md('"가"와 "나"와 "다"와 "라"'))).not.toContain('J-2');
    expect(md('"가"와 "나"와 "다"와 "라"와 "마"').filter((f) => f.id === 'J-2')).toHaveLength(5);
    expect(md('따라서 1. 따라서 2. 따라서 3.').filter((f) => f.id === 'D-1')).toHaveLength(0);
  });

  it('출력에 파일, 줄, ID, 걸린 원문을 남긴다', () => {
    expect(md('첫 줄\n\n둘째 `코드` 줄은 가지고 있다.')).toEqual([
      { path: 'doc.md', line: 3, id: 'A-7', text: '가지고 있' },
    ]);
  });
});

describe('AC-M1-22 T1-25 문구 검사: 건너뛰는 곳', () => {
  it('코드 블록, 인라인 코드, URL, 링크 주소, 표의 경로 칸은 보지 않는다', () => {
    const source = [
      '```ts',
      "const a = '가지고 있다 🚀';",
      '```',
      '~~~',
      '되어진다',
      '~~~',
      '`가지고 있다`와 ``되어진`다`` 는 코드다.',
      '주소 https://example.com/가지고있다 와 <https://example.com/되어진> 를 본다.',
      '[규칙](../writing-style.md#가지고-있다) 링크.',
      '[참조]: ./되어진다.md',
      '| 파일 | 설명 |',
      '| ---- | ---- |',
      '| docs/가지고있다/되어진.md | 경로 칸 |',
    ].join('\n');
    expect(md(source)).toEqual([]);
  });

  it('코드 밖으로 나오면 다시 본다', () => {
    expect(ids(md('```\n코드\n```\n가지고 있다'))).toEqual(['A-7']);
  });

  it('들여쓴 코드 블록은 보지 않고, 같은 문장이 코드 밖에 있으면 본다', () => {
    expect(md('예시:\n\n    const a = "가지고 있다";\n')).toEqual([]);
    expect(md('# 제목\n    const a = "가지고 있다";')).toEqual([]);
    expect(md('예시:\n\n    const a = "가지고 있다";\n\n    되어진다\n\n장수는 가지고 있다.')).toEqual([
      { path: 'doc.md', line: 7, id: 'A-7', text: '가지고 있' },
    ]);
  });

  it('문단 중간의 들여쓴 줄과 목록 항목의 이어지는 문단은 코드가 아니다', () => {
    expect(ids(md('문단 첫 줄\n    가지고 있다'))).toEqual(['A-7']);
    expect(ids(md('- 항목\n\n    가지고 있다'))).toEqual(['A-7']);
    expect(ids(md('1. 항목\n\n   가지고 있다'))).toEqual(['A-7']);
    expect(ids(md('- 항목\n  - 하위 항목\n\n      가지고 있다'))).toEqual(['A-7']);
    expect(md('- 항목\n\n      const a = "가지고 있다";')).toEqual([]);
  });

  it('인용과 목록 안의 펜스 코드 블록도 보지 않는다', () => {
    expect(md('> ```ts\n> const a = "가지고 있다";\n> ```')).toEqual([]);
    expect(md('> > ~~~\n> > 되어진다\n> > ~~~')).toEqual([]);
    expect(md('>     const a = "가지고 있다";')).toEqual([]);
    expect(md('- 항목\n\n  ```ts\n  const a = "가지고 있다";\n  ```')).toEqual([]);
    expect(md('- ```ts\n  const a = "가지고 있다";\n  ```')).toEqual([]);
  });

  it('인용이나 목록 항목이 끝나면 그 안의 코드 블록도 끝난다', () => {
    expect(md('> ```ts\n> 코드\n> ```\n> 가지고 있다').map((f) => f.line)).toEqual([4]);
    expect(md('> ```\n> 코드\n가지고 있다').map((f) => f.line)).toEqual([3]);
    expect(md('- 항목\n\n  ```\n  코드\n가지고 있다').map((f) => f.line)).toEqual([5]);
    expect(md('```\n코드\n```ts 가 아니다\n가지고 있다\n```').map((f) => f.line)).toEqual([]);
    expect(md('```가지고``` 는 펜스가 아니다\n가지고 있다').map((f) => f.line)).toEqual([2]);
    expect(md('가지고 ```있다``` 는 인라인 코드다\n가지고 있다').map((f) => f.line)).toEqual([2]);
  });

  it('표의 경로가 아닌 칸은 본다', () => {
    expect(ids(md('| 이름 | 설명 |\n| --- | --- |\n| 장수 | 무력을 가지고 있다 |'))).toEqual(['A-7']);
  });

  it('비공개 폴더 private/는 대상이 아니다', () => {
    expect(classify('private/v1/backlog.md')).toBeNull();
    expect(classify('docs/index.md')).toMatchObject({ kind: 'markdown' });
    expect(classify('CLAUDE.md')).toBeNull();
  });

  it('코드는 대상 폴더의 소스만 보고 테스트 파일은 뺀다', () => {
    expect(classify('apps/web/src/App.tsx')).toEqual({ path: 'apps/web/src/App.tsx', kind: 'code', koreanOnly: false });
    expect(classify('apps/server/src/router.ts')).toMatchObject({ koreanOnly: true });
    expect(classify('packages/rules/src/commands.ts')).toMatchObject({ koreanOnly: true });
    expect(classify('apps/web/src/App.test.tsx')).toBeNull();
    expect(classify('apps/engine/src/index.ts')).toBeNull();
    expect(classify('apps/web/src/vite-env.d.ts')).toBeNull();
  });
});

describe('AC-M1-22 T1-25 문구 검사: 코드의 문자열과 JSX 텍스트', () => {
  it('문자열, 템플릿, JSX 텍스트, JSX 속성을 줄 번호와 함께 본다', () => {
    const source = [
      "import { x } from './가지고있다';",
      '// 주석은 보지 않는다: 가지고 있다',
      "const a = '무력을 가지고 있다';",
      'const b = `기록되어진다 ${a} 그리고 또 기록되어진다`;',
      'export const C = () => (',
      '  <p title="🚀 시작">',
      '    능력을 가지고 있다',
      '  </p>',
      ');',
    ].join('\n');
    expect(code(source).map((f) => `${f.line} ${f.id} ${f.text}`)).toEqual([
      '3 A-7 가지고 있',
      '4 A-8 되어진',
      '4 A-8 되어진',
      '6 C-5 🚀',
      '7 A-7 가지고 있',
    ]);
  });

  it('한글만 보는 폴더에서는 한글 없는 문자열을 건너뛴다', () => {
    expect(code("const a = '🚀';", 'a.ts', true)).toEqual([]);
    expect(ids(code("const a = '🚀 출병';", 'a.ts', true))).toEqual(['C-5']);
  });

  it('문자열, 템플릿, JSX의 URL은 가리고 같은 문자열의 나머지 문구는 본다', () => {
    expect(code('const url = "https://example.test/되어진다";')).toEqual([]);
    expect(code('const url = "https://example.test/되어진다";', 'a.ts', true)).toEqual([]);
    expect(code("const s = '주소 https://example.test/되어진다 는 기록되어진다';")).toEqual([
      { path: 'a.tsx', line: 1, id: 'A-8', text: '되어진' },
    ]);
    expect(ids(code('const u = `https://example.test/${id}/되어진다/${x} 그리고 기록되어진다`;'))).toEqual(['A-8']);
    expect(
      ids(
        code(
          'const C = () => <a href="https://example.test/가지고있다" title="가지고 있다">www.example.test/되어진</a>;',
        ),
      ),
    ).toEqual(['A-7']);
    const source = ['const u = `', 'https://example.test/되어진다', '${id} 가지고 있다', '`;'].join('\n');
    expect(code(source).map((f) => `${f.line} ${f.id} ${f.text}`)).toEqual(['3 A-7 가지고 있']);
  });

  it('타입 자리의 템플릿 문자열도 본다', () => {
    expect(ids(code('type T = `가지고 있다 ${string}`;', 'a.ts'))).toEqual(['A-7']);
  });
});

describe('AC-M1-22 T1-25 문구 검사: 예외 표시', () => {
  it('마크다운은 줄 끝 HTML 주석의 ID만 예외로 둔다', () => {
    expect(md('무력을 가지고 있다 <!-- lint-text-ignore A-7 -->')).toEqual([]);
    expect(ids(md('무력을 가지고 있다 되어진다 <!-- lint-text-ignore A-7 -->'))).toEqual(['A-8']);
    expect(md('가지고 있다 되어진다 <!-- lint-text-ignore A-7, A-8 -->')).toEqual([]);
    expect(ids(md('가지고 있다 `<!-- lint-text-ignore A-7 -->`'))).toEqual(['A-7']);
    expect(ids(md('가지고 있다\n<!-- lint-text-ignore A-7 -->'))).toEqual(['A-7']);
  });

  it('코드는 같은 줄의 lint-text-ignore 주석을 본다', () => {
    expect(code("const a = '가지고 있다'; // lint-text-ignore A-7")).toEqual([]);
    expect(code('const C = () => <p>가지고 있다 {/* lint-text-ignore A-7 */}</p>;')).toEqual([]);
    expect(ids(code("const a = '가지고 있다'; // lint-text-ignore A-8"))).toEqual(['A-7']);
  });

  it('코드의 예외 표시는 실제 주석만 인정하고 문자열과 JSX 텍스트의 글자는 무시한다', () => {
    expect(ids(code('const a = "가지고 있다 lint-text-ignore A-7";'))).toEqual(['A-7']);
    expect(ids(code('const a = "가지고 있다"; const b = "lint-text-ignore A-7";'))).toEqual(['A-7']);
    expect(ids(code('const C = () => <p>가지고 있다 lint-text-ignore A-7</p>;'))).toEqual(['A-7']);
    expect(ids(code('const C = () => <p>가지고 있다 // lint-text-ignore A-7</p>;'))).toEqual(['A-7']);
    expect(ids(code('const a = `가지고 있다 /* lint-text-ignore A-7 */`;'))).toEqual(['A-7']);
    expect(ids(code('const C = () => <p title="lint-text-ignore A-7">가지고 있다</p>;'))).toEqual(['A-7']);
    expect(code('const a = `가지고 있다 ${b /* lint-text-ignore A-7 */}`;')).toEqual([]);
    expect(code('/* lint-text-ignore A-7 */ const a = "가지고 있다";')).toEqual([]);
    expect(ids(code('const a = "가지고 있다";\n// lint-text-ignore A-7'))).toEqual(['A-7']);
  });

  it('문자열의 예외 표시는 문서당 횟수에서도 빠지지 않는다', () => {
    const line = "const a = '따라서 1. 따라서 2. 따라서 3. 따라서 4.";
    expect(ids(code(`${line} lint-text-ignore D-1';`))).toEqual(['D-1', 'D-1', 'D-1', 'D-1']);
    expect(code(`${line}'; // lint-text-ignore D-1`)).toEqual([]);
    expect(code(`${line}';`)).toHaveLength(4);
  });

  it('예외로 둔 곳은 문서당 횟수에서도 빠진다', () => {
    const source = '따라서 1.\n따라서 2.\n따라서 3.\n따라서 4. <!-- lint-text-ignore D-1 -->';
    expect(md(source)).toEqual([]);
  });
});

describe('AC-M1-22 T1-25 pnpm lint:text 명령', () => {
  function fixture(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'lint-text-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }
  function run(cwd: string, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const status = main(args, cwd, { log: (line) => out.push(line), error: (line) => err.push(line) });
    return { status, stdout: out.join('\n'), stderr: err.join('\n') };
  }

  it('기본은 경고만 내고 성공한다. --strict면 실패한다', () => {
    const dir = fixture({
      'docs/a.md': '무력을 가지고 있다\n',
      'private/b.md': '가지고 있다\n',
      'apps/web/src/C.tsx': "export const s = '🚀';\n",
    });
    const warn = run(dir);
    expect(warn.status).toBe(0);
    expect(warn.stdout).toContain('docs/a.md:1 [A-7] 가지고 있');
    expect(warn.stdout).toContain('apps/web/src/C.tsx:1 [C-5] 🚀');
    expect(warn.stdout).not.toContain('private');
    expect(warn.stdout).toContain('2건');
    expect(run(dir, '--strict').status).toBe(1);
  });

  it('걸린 곳이 없으면 --strict도 성공한다', () => {
    const dir = fixture({ 'docs/a.md': '무력이 강하다\n' });
    const strict = run(dir, '--strict', 'docs');
    expect(strict.status).toBe(0);
    expect(strict.stdout).toContain('걸린 곳 없음');
  });

  it('없는 경로와 모르는 옵션은 사용 오류(2)로 끝난다', () => {
    const dir = fixture({ 'docs/a.md': '' });
    expect(run(dir, 'nope')).toMatchObject({ status: 2, stderr: '경로가 없습니다: nope' });
    expect(run(dir, '--fix').status).toBe(2);
  });

  it('경로를 주면 그 아래만 본다', () => {
    const dir = fixture({ 'docs/a.md': '가지고 있다\n', 'docs/sub/b.md': '되어진다\n' });
    expect(collectTargets(dir, ['docs/sub']).map((t) => t.path)).toEqual(['docs/sub/b.md']);
    expect(collectTargets(dir, ['private'])).toEqual([]);
    expect(() => collectTargets(dir, ['../outside'])).toThrow('저장소 밖');
    expect(collectTargets(dir, [join(dir, 'docs/sub/b.md')]).map((t) => t.path)).toEqual(['docs/sub/b.md']);
    expect(() => collectTargets(dir, [tmpdir()])).toThrow('저장소 밖');
  });

  it('리뷰에서 찾은 예외 표시, 코드 블록, URL의 종료 코드', () => {
    const caught = fixture({
      'apps/web/src/A.tsx': 'export const a = "가지고 있다 lint-text-ignore A-7";\n',
      'apps/web/src/B.tsx': 'export const a = "가지고 있다";\nexport const b = "lint-text-ignore A-7";\n',
      'apps/web/src/C.tsx': 'export const C = () => <p>가지고 있다 lint-text-ignore A-7</p>;\n',
      'docs/a.md': '예시:\n\n    코드\n\n장수는 가지고 있다.\n',
    });
    const caughtRun = run(caught, '--strict');
    expect(caughtRun.status).toBe(1);
    expect(caughtRun.stdout).toContain('4건 (A-7 4)');

    const clean = fixture({
      'apps/web/src/A.tsx': 'export const a = "가지고 있다"; // lint-text-ignore A-7\n',
      'apps/web/src/C.tsx': 'export const C = () => <p>가지고 있다 {/* lint-text-ignore A-7 */}</p>;\n',
      'apps/web/src/U.ts': 'export const url = "https://example.test/되어진다";\n',
      'docs/a.md': '예시:\n\n    const a = "가지고 있다";\n',
      'docs/b.md': '> ```ts\n> const a = "가지고 있다";\n> ```\n',
    });
    const cleanRun = run(clean, '--strict');
    expect(cleanRun).toMatchObject({ status: 0, stderr: '' });
    expect(cleanRun.stdout).toContain('걸린 곳 없음');
  });

  it('실제 명령의 종료 코드: 경고 0, --strict 1', { timeout: 60_000 }, () => {
    const dir = fixture({ 'docs/a.md': '무력을 가지고 있다\n' });
    const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
    const cli = fileURLToPath(new URL('cli.ts', import.meta.url));
    const warn = spawnSync(tsx, [cli], { cwd: dir, encoding: 'utf8' });
    expect(warn.status).toBe(0);
    expect(warn.stdout).toContain('docs/a.md:1 [A-7] 가지고 있');
    expect(spawnSync(tsx, [cli, '--strict'], { cwd: dir, encoding: 'utf8' }).status).toBe(1);
  });
});
