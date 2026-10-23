import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commands, extensionCommands } from '../packages/rules/src/index';
import {
  STAGES,
  analyze,
  exitCode,
  findSection,
  loadContext,
  main,
  readRegistryKeys,
  readExtensionRegistryKeys,
  verifyCiRuns,
} from './command-coverage.mjs';

it('AC-M1-14 모든 registry key에 성공·실패 행동 테스트 파일이 있다', async () => {
  for (const command of commands) {
    const source = await readFile(
      new URL(`../packages/rules/src/commands/${command.key}.test.ts`, import.meta.url),
      'utf8',
    );
    expect(source).toContain("it('성공'");
    expect(source).toContain("it('실패'");
    expect(source).toContain(`verifySuccess('${command.key}')`);
    expect(source).toContain(`verifyFailure('${command.key}')`);
  }
});

const root = fileURLToPath(new URL('..', import.meta.url));
const tablePath = join(root, 'docs/product/command-coverage.json');
const context = loadContext(root);
type Context = ReturnType<typeof loadContext>;
type Evidence = { kind: string; ref: string; sha?: string };
type Stage = { status: string; evidence: Evidence[]; reason?: string };
type Row = {
  id: string;
  target: string;
  sourceIds: string[];
  replacementReason: string | null;
  approvalRefs: string[];
  acIds: string[];
  stages: Record<string, Stage>;
};
type Doc = {
  referenceCommands: { id: string; target: string }[];
  unresolvedReferences: { id: string }[];
  commands: Row[];
};
type Baseline = {
  referenceRevision: { commit: string; general: { ids: string[] }; nation: { ids: string[] } };
  verificationRecords: { id: string; sha: string; runs: { id: string; conclusion: string }[] }[];
};
const table = (): Doc => JSON.parse(readFileSync(tablePath, 'utf8')) as Doc;
const row = (doc: Doc, id: string) => doc.commands.find((command) => command.id === id)!;
const errorsOf = (doc: Doc, ctx: Context = context) => analyze(doc, ctx).errors.join('\n');
const withDocs = (change: Partial<Context>): Context => ({ ...context, ...change });
const SHA_81 = '81ffd1b65be7b2799a74ee6de2fdac8f984cd00c';
const SHA_1FF = '1ffde70cfca4419ee23c972695005165fa3c8ed9';
const RUN = (id: string | number) => `https://github.com/peppone-choi/opensamguk/actions/runs/${id}`;

describe('T4-02 등록된 확장 명령 대조', () => {
  const fixture = (files: Record<string, string>, run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-ext-'));
    try {
      for (const [path, source] of Object.entries(files)) {
        const file = join(dir, 'packages/rules/src/commands', path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const command = (key: string, target = 'general') => `({ key: '${key}', target: '${target}' })`;

  it('운영 확장 목록의 key·target이 실제 extensionCommands와 순서까지 같다', () => {
    expect(readExtensionRegistryKeys(root)).toEqual(extensionCommands.map(({ key, target }) => ({ key, target })));
  });

  it('실제 import 별칭·재수출·const 별칭·배열 참조와 spread만 따라가고 미등록 이웃 정의는 빼놓는다', () => {
    fixture(
      {
        'ext/registry.ts': `import { registered as chosen } from './barrel.ts';
        const alias = chosen; const local = [...alias];
        export const extensionCommands = ([...local] as const) satisfies readonly unknown[];`,
        'ext/barrel.ts': `export { active as registered } from './definitions.ts';`,
        'ext/definitions.ts': `import { unavailable } from 'not-installed';
        const first = ${command('fire_attack')};
        export const unusedSibling = ${command('never_registered')};
        export const active = [first, ${command('nation_research_fire_wheel', 'nation')}];`,
        'ext/not-referenced.ts': 'this file is not valid TypeScript @',
      },
      (dir) => {
        const actualSource = join(dir, 'packages/rules/src/commands/ext/definitions.ts');
        // 실행 fixture는 설치되지 않은 외부 import를 뺀다. 정적 탐색은 사용한 참조만 읽는다.
        writeFileSync(
          actualSource,
          readFileSync(actualSource, 'utf8').replace("import { unavailable } from 'not-installed';", ''),
        );
        const file = pathToFileURL(join(dir, 'packages/rules/src/commands/ext/registry.ts')).href;
        const runtime = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const {extensionCommands}=await import(${JSON.stringify(file)}); console.log(JSON.stringify(extensionCommands));`,
          ],
          { encoding: 'utf8' },
        );
        expect(runtime.status, runtime.stderr).toBe(0);
        expect(readExtensionRegistryKeys(dir)).toEqual(JSON.parse(runtime.stdout));
        expect(readExtensionRegistryKeys(dir).map(({ key }: { key: string }) => key)).not.toContain('never_registered');
        writeFileSync(
          actualSource,
          `import { unavailable } from 'not-installed';\n${readFileSync(actualSource, 'utf8')}`,
        );
        expect(readExtensionRegistryKeys(dir)).toHaveLength(2);
      },
    );
  });

  it('공통 defineCommand의 기본 general과 명시 nation을 실제 실행 결과와 대조한다', () => {
    fixture(
      {
        'support.ts': `export const defineCommand = spec => ({...spec, target: spec.target ?? 'general'});`,
        'ext/actions.ts': `import { defineCommand as define } from '../support.ts';
        const key = 'fire_attack'; export const first = define({ key });
        export const second = define({ key: 'nation_research_fire_wheel', target: 'nation' });`,
        'ext/registry.ts': `import { first, second } from './actions.ts'; export const extensionCommands = [first, second];`,
      },
      (dir) => {
        const file = pathToFileURL(join(dir, 'packages/rules/src/commands/ext/registry.ts')).href;
        const runtime = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const {extensionCommands}=await import(${JSON.stringify(file)}); console.log(JSON.stringify(extensionCommands));`,
          ],
          { encoding: 'utf8' },
        );
        expect(runtime.status, runtime.stderr).toBe(0);
        expect(readExtensionRegistryKeys(dir)).toEqual(JSON.parse(runtime.stdout));
      },
    );
  });

  it.each([
    ['push 등록', `export const extensionCommands = []; extensionCommands.push(${command('fire_attack')});`],
    [
      '조건부 등록',
      `export const extensionCommands = []; if (true) extensionCommands.push(${command('fire_attack')});`,
    ],
    ['배열 map 호출', `const source = []; export const extensionCommands = source.map(x => x);`],
    ['임의 factory', `const make = () => ${command('fire_attack')}; export const extensionCommands = [make()];`],
    ['변경 가능한 변수', `let chosen = ${command('fire_attack')}; export const extensionCommands = [chosen];`],
    ['계산된 target', `export const extensionCommands = [{ key: 'fire_attack', target: choose() }];`],
    ['target 없음', `export const extensionCommands = [{ key: 'fire_attack' }];`],
    ['모르는 target', `export const extensionCommands = [${command('fire_attack', 'other')}];`],
    ['숨겨진 덮어쓰기', `export const extensionCommands = [{...${command('fire_attack')}}];`],
    ['key 중복', `export const extensionCommands = [${command('fire_attack')}, ${command('fire_attack', 'nation')}];`],
    ['key 속성 중복', `export const extensionCommands = [{key:'a', key:'b', target:'general'}];`],
    ['배열 아님', `export const extensionCommands = ${command('fire_attack')};`],
    ['명령 아닌 배열 항목', `export const extensionCommands = ['fire_attack'];`],
    ['배열 빈칸', `export const extensionCommands = [,];`],
    ['순환 참조', `const first = second; const second = first; export const extensionCommands = first;`],
    ['없는 참조', `export const extensionCommands = [missing];`],
    ['구문 오류', `export const extensionCommands = [;`],
  ])('%s은 조용히 생략하지 않고 실패한다', (_name, source) => {
    fixture({ 'ext/registry.ts': source }, (dir) => {
      expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry');
    });
  });

  it('등록한 확장의 누락·다른 대상·기본 key와 충돌을 실패시키고 기본 37개 집계는 보존한다', () => {
    fixture({ 'ext/registry.ts': `export const extensionCommands = [${command('fire_attack')}];` }, (dir) => {
      const extensionRegistry = readExtensionRegistryKeys(dir);
      const ctx = withDocs({ extensionRegistry });
      const valid = analyze(table(), ctx);
      expect(valid.errors).toEqual([]);
      expect(valid.summary!.legacySubset).toEqual(analyze(table(), context).summary!.legacySubset);
      expect(valid.summary!.denominator).toBe(91);
      expect(valid.summary!.unresolvedReferences).toBe(3);
      const doc = table();
      doc.commands = doc.commands.filter(({ id }) => id !== 'fire_attack');
      expect(errorsOf(doc, ctx)).toContain('registry key fire_attack(general)가 대응표에 없다');
      expect(errorsOf(table(), withDocs({ extensionRegistry: [{ key: 'fire_attack', target: 'nation' }] }))).toContain(
        'commands[fire_attack]: registry target nation와 다르다',
      );
      expect(errorsOf(table(), withDocs({ extensionRegistry: [{ key: 'farm', target: 'general' }] }))).toContain(
        '확장 registry key farm가 기본·확장 목록과 겹친다',
      );
      writeFileSync(
        join(dir, 'packages/rules/src/commands/ext/registry.ts'),
        `export const extensionCommands = [${command('not_in_table')}];`,
      );
      expect(errorsOf(table(), withDocs({ extensionRegistry: readExtensionRegistryKeys(dir) }))).toContain(
        'registry key not_in_table(general)가 대응표에 없다',
      );
    });
  });

  it('등록 표현식을 읽지 못하면 CLI도 exit 1로 실패한다', () => {
    fixture({ 'ext/registry.ts': 'export const extensionCommands = createUnknown();' }, (dir) => {
      for (const file of [
        'domestic/investment.ts',
        'rest.ts',
        'military.ts',
        'attack.ts',
        'personnel.ts',
        'personal.ts',
        'nation.ts',
      ]) {
        const path = join(dir, 'packages/rules/src/commands', file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }
      const result = main(['--root', dir, '--file', tablePath]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('registry를 읽지 못했다: 확장 registry');
    });
  });
});

describe('AC-M1-14 전체 명령 대응표 (D-022)', () => {
  it('정적으로 읽은 registry key가 실제 rules의 commands와 같다', () => {
    const actual = commands.map((command) => ({ key: command.key, target: command.target }));
    const sort = (list: { key: string }[]) => [...list].sort((a, b) => a.key.localeCompare(b.key));
    expect(sort(readRegistryKeys(root))).toEqual(sort(actual));
  });

  it('정본은 정합이고 원작 90개·정본 분모·37개 부분집합·단계 집계를 따로 낸다', () => {
    const { errors, gaps, summary: result } = analyze(table(), context);
    const summary = result!;
    expect(errors).toEqual([]);
    expect(summary.reference).toEqual({ total: 90, general: 55, nation: 35 });
    expect(summary.legacySubset).toEqual({ registryKeys: 37, general: 27, nation: 10, inTable: 37 });
    expect(summary.denominator).toBe(summary.commands + summary.unresolvedReferences);
    expect(summary.mappedReferences + summary.unresolvedReferences).toBe(90);
    expect(summary.complete).toBeLessThan(summary.denominator);
    expect(gaps.length).toBe(summary.denominator - summary.complete);
  });

  it('고정 기준의 원본 ID 전집은 core2026 df6c926에서 뽑은 55·35개 그대로다', () => {
    const baseline = context.baseline as Baseline;
    const { general, nation, commit } = {
      ...baseline.referenceRevision,
      general: baseline.referenceRevision.general.ids,
      nation: baseline.referenceRevision.nation.ids,
    };
    expect(commit).toBe('df6c9269fa1e2862418ba9da481c8dd2d758d6c5');
    expect([general.length, nation.length]).toEqual([55, 35]);
    expect(createHash('sha256').update(JSON.stringify({ general, nation })).digest('hex')).toBe(
      '7ffb91e2bc4de045e7c840fea3c4f867218ede8e802e8cc56bee6016ced0669d',
    );
    expect(table().referenceCommands.map((ref) => ref.id)).toEqual([
      ...general.map((id) => `general:${id}`),
      ...nation.map((id) => `nation:${id}`),
    ]);
  });

  it('기본 실행은 정합이면 0, --require-complete는 남은 일이 있으면 1로 끝난다 (실제 node 실행)', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['tools/command-coverage.mjs', ...args], { cwd: root, encoding: 'utf8' });
    const plain = run();
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(plain.stdout).toContain('대응표 정합: 통과');
    expect(plain.stdout).toContain('제품 전체 완료: 미완료');
    const gate = run('--require-complete');
    expect(gate.status).toBe(1);
    expect(gate.stdout).toContain('남음 nation_research_fire_wheel');
    expect(run('--모르는').status).toBe(2);
  });

  it('반례: 원본 삭제는 고정 원본 전집 누락과 모르는 원본 대응으로 실패한다', () => {
    const doc = table();
    doc.referenceCommands = doc.referenceCommands.filter((ref) => ref.id !== 'general:che_화계');
    const errors = errorsOf(doc);
    expect(errors).toContain('고정 원본 ID general:che_화계가 referenceCommands에 없다');
    expect(errors).toContain('원본 목록에 없는 ID general:che_화계');
  });

  it('반례: 명령 행 삭제는 registry key 누락과 원본 누락으로 실패한다', () => {
    const doc = table();
    doc.commands = doc.commands.filter((command) => command.id !== 'farm');
    const errors = errorsOf(doc);
    expect(errors).toContain('registry key farm(general)가 대응표에 없다');
    expect(errors).toContain('원본 general:che_농지개간의 대응이나 unresolved가 없다');
  });

  it('반례: 미해결 원본을 지우면 누락으로 실패한다', () => {
    const doc = table();
    doc.unresolvedReferences = doc.unresolvedReferences.filter((item) => item.id !== 'general:che_NPC능동');
    expect(errorsOf(doc)).toContain('원본 general:che_NPC능동의 대응이나 unresolved가 없다');
  });

  it('반례: 이중 매핑과 승인 없는 이름 통합, 중복 ID는 실패한다', () => {
    const doc = table();
    row(doc, 'commerce').sourceIds.push('general:che_농지개간');
    doc.commands.push(structuredClone(row(doc, 'rest')));
    const errors = errorsOf(doc);
    expect(errors).toContain('원본 general:che_농지개간가 commands[farm]와 commands[commerce]에 이중 매핑됐다');
    expect(errors).toContain('commands[commerce]: 원본 2개 대응(추가·이름 통합)은 replacementReason과 승인 근거');
    expect(errors).toContain('commands[commerce]: 원본 통합이 고정 기준의 승인 목록에 없다');
    expect(errors).toContain('명령 ID rest가 두 번 있다');
  });

  it('반례: 파일만 있는 verified, SHA 없는 verified, registry 없는 구현 주장은 실패한다', () => {
    const doc = table();
    row(doc, 'farm').stages.ui = {
      status: 'verified',
      evidence: [{ kind: 'test', ref: 'packages/rules/src/commands/farm.test.ts' }],
    };
    row(doc, 'fire_attack').stages.engine = { status: 'verified', evidence: [{ kind: 'ci', ref: RUN(1) }] };
    const errors = errorsOf(doc);
    expect(errors).toContain('commands[farm].ui: verified에는 검증한 정확한 전체 SHA가 있어야 한다');
    expect(errors).toContain('commands[fire_attack].engine: verified에는 검증한 정확한 전체 SHA가 있어야 한다');
    expect(errors).toContain('commands[fire_attack].engine: registry에 없는 key인데 구현됐다고 적었다');
  });

  it('반례 R67-COV-1: 가짜 실행·무관한 문서 SHA·7자리 SHA·다른 단계로 옮긴 기록은 verified가 아니다', () => {
    const fake = table();
    row(fake, 'farm').stages.ui = {
      status: 'verified',
      evidence: [
        { kind: 'ci', ref: RUN(1) },
        { kind: 'doc', ref: 'docs/plans/T1-05.md', sha: 'ab6f803bfcefac4907d7fb9b87eae4fd7740934d' },
      ],
    };
    expect(errorsOf(fake)).toContain(
      'commands[farm].ui: verified는 독립 리뷰 기록(review)과 같은 SHA의 실행(ci)이 함께 있어야 한다',
    );
    const short = table();
    row(short, 'farm').stages.ui = { status: 'verified', evidence: [{ kind: 'ci', ref: RUN(1), sha: 'ab6f803' }] };
    expect(errorsOf(short)).toContain('commands[farm].ui: verified 근거의 sha ab6f803는 40자리 전체 SHA여야 한다');
    const moved = table();
    row(moved, 'farm').stages.ui = structuredClone(row(moved, 'farm').stages.engine!);
    expect(errorsOf(moved)).toContain('commands[farm].ui: 검증 기록 T1-08-rereview-81ffd1b는 ui 단계를 다루지 않는다');
    const other = table();
    row(other, 'fire_attack').stages.engine = structuredClone(row(other, 'farm').stages.engine!);
    expect(errorsOf(other)).toContain('검증 기록 T1-08-rereview-81ffd1b는 명령 fire_attack를 다루지 않는다');
  });

  it('반례 R67-COV-1: 틀린 실행 SHA, 기록에 없는 실행, 검토 전 문서 절은 거부한다', () => {
    const wrongSha = table();
    row(wrongSha, 'farm').stages.engine!.evidence.find((item) => item.kind === 'ci')!.sha = SHA_1FF;
    const wrongShaErrors = errorsOf(wrongSha);
    expect(wrongShaErrors).toContain('commands[farm].engine: verified 근거의 SHA가 서로 다르다');
    expect(wrongShaErrors).toContain('commands[farm].engine: 실행 39537902044의 SHA가 검증 기록 SHA와 다르다');
    const otherRun = table();
    row(otherRun, 'farm').stages.engine!.evidence.find((item) => item.kind === 'ci')!.ref = RUN(39540683895);
    expect(errorsOf(otherRun)).toContain(
      'commands[farm].engine: 실행 39540683895는 검증 기록 T1-08-rereview-81ffd1b가 확인한 실행이 아니다',
    );
    const beforeReview = table();
    row(beforeReview, 'farm').stages.engine!.evidence.find((item) => item.kind === 'review')!.ref =
      'docs/plans/T1-08.md#계획-claude';
    expect(errorsOf(beforeReview)).toContain(
      `commands[farm].engine: 리뷰 근거 docs/plans/T1-08.md#계획-claude@${SHA_81}가 고정 검증 기록`,
    );
  });

  it('반례 R67-COV-1: 실패한 실행, 통과가 아닌 리뷰 절, SHA·실행을 적지 않은 리뷰 절은 기록으로 인정하지 않는다', () => {
    const failed = structuredClone(context.baseline) as Baseline;
    failed.verificationRecords[0]!.runs[0]!.conclusion = 'failure';
    expect(errorsOf(table(), withDocs({ baseline: failed }))).toContain(
      '검증 기록 T1-08-rereview-81ffd1b: 실행 39537902044의 결과가 success가 아니다 (failure)',
    );
    const reviewOriginal = context.readDoc('docs/plans/T1-08.md');
    const reviewRejected = reviewOriginal.replace('- 결과: 통과. 검토한 SHA는', '- 결과: 수정 필요. 검토한 SHA는');
    expect(reviewRejected, 'T1-08 리뷰 절 치환이 원문을 바꾸지 않았다').not.toBe(reviewOriginal);
    const rejected = withDocs({
      readDoc: (path: string) => (path === 'docs/plans/T1-08.md' ? reviewRejected : context.readDoc(path)),
    });
    expect(errorsOf(table(), rejected)).toContain('검증 기록 T1-08-rereview-81ffd1b: 리뷰 절의 결과가 통과가 아니다');
    const unrelated = structuredClone(context.baseline) as Baseline;
    unrelated.verificationRecords[0]!.sha = 'ab6f803bfcefac4907d7fb9b87eae4fd7740934d';
    const unrelatedErrors = errorsOf(table(), withDocs({ baseline: unrelated }));
    expect(unrelatedErrors).toContain('리뷰 절이 전체 SHA ab6f803bfcefac4907d7fb9b87eae4fd7740934d를 적지 않았다');
    expect(unrelatedErrors).toContain('실행 39537902044의 headSha');
  });

  it('반례 R67-COV-1: --verify-ci는 실제 실행의 head_sha와 결과를 다시 대조한다', () => {
    const ok = verifyCiRuns(context.baseline, (id: string) => ({
      head_sha: ['39537902044', '39537898373'].includes(id) ? SHA_81 : SHA_1FF,
      conclusion: 'success',
    }));
    expect(ok).toEqual([]);
    const bad = verifyCiRuns(context.baseline, (id: string) => ({
      head_sha: SHA_81,
      conclusion: id === '39537902044' ? 'failure' : 'success',
    })).join('\n');
    expect(bad).toContain('실행 39537902044의 실제 결과가 failure이다');
    expect(bad).toContain(`실행 39540683895의 실제 head_sha ${SHA_81}가 ${SHA_1FF}와 다르다`);
  });

  it('반례 R67-COV-2: 승인된 추가 삭제, 승인된 대체 근거 삭제, 개수 보존 원본 ID 치환, 승인 없는 추가는 실패한다', () => {
    const noTrade = table();
    noTrade.commands = noTrade.commands.filter((command) => command.id !== 'trade');
    expect(errorsOf(noTrade)).toContain('승인된 addition trade(D-010, D-014) 행이 대응표에 없다');
    const bare = table();
    row(bare, 'nation_peace').replacementReason = null;
    row(bare, 'nation_peace').approvalRefs = [];
    const bareErrors = errorsOf(bare);
    expect(bareErrors).toContain('commands[nation_peace]: 승인된 replacement의 replacementReason이 없다');
    expect(bareErrors).toContain('commands[nation_peace]: 승인된 replacement의 근거 D-014가 approvalRefs에 없다');
    const swapped = table();
    swapped.referenceCommands.find((ref) => ref.id === 'general:che_화계')!.id = 'general:che_없는명령';
    row(swapped, 'fire_attack').sourceIds = ['general:che_없는명령'];
    const swappedErrors = errorsOf(swapped);
    expect(swappedErrors).toContain('고정 원본 ID general:che_화계가 referenceCommands에 없다');
    expect(swappedErrors).toContain('원본 general:che_없는명령는 고정 원작 revision의 ID가 아니다');
    const extra = table();
    extra.commands.push({ ...structuredClone(row(extra, 'trade')), id: 'trade2' });
    expect(errorsOf(extra)).toContain('commands[trade2]: 원본 없는 추가 명령이 고정 기준의 승인 목록에 없다');
  });

  it('반례 R67-COV-3: 문서의 거짓 전체 완료, 옛 37개 범위, 분모·집계 불일치는 각각 실패한다', () => {
    // M1 집계는 숫자를 박아 두지 않고 현재 정본 문서(README 관문 행·인수조건 요약 행)에서 읽는다.
    // 문서 집계가 바뀌어도 반례가 no-op 치환으로 조용히 빠지지 않게 한다.
    const readmeM1Line = context.readme.split('\n').find((line: string) => line.startsWith('| M1 '))!;
    const readmeM1 = /진행 중 \(✅ (\d+) · 🟨 (\d+) · ⬜ (\d+)\)/.exec(readmeM1Line ?? '');
    expect(readmeM1, 'README M1 관문 행에 진행 중 집계가 있어야 한다').not.toBeNull();
    const acSummary = context.acceptance.split('\n## 요약')[1]!.split('\n## ')[0]!;
    const acM1Line = acSummary.split('\n').find((line: string) => line.startsWith('| M1 '))!;
    const acM1 = /^(\| M1 [^|]*\|)(\s*)(\d+)(\s*\|\s*)(\d+)(\s*\|\s*)(\d+)(\s*\|\s*)(\d+)(\s*\|.*)$/.exec(
      acM1Line ?? '',
    );
    expect(acM1, '인수조건 요약에 M1 행이 있어야 한다').not.toBeNull();
    const [m1Ok, m1Partial, m1Todo] = readmeM1!.slice(1).map(Number) as [number, number, number];
    const m1Total = Number(acM1![3]);
    // 정본은 README와 인수조건 요약이 같은 집계이고, M1은 아직 통과하지 않았다(🟨+⬜ > 0).
    expect([acM1![5], acM1![7], acM1![9]].map(Number)).toEqual([m1Ok, m1Partial, m1Todo]);
    expect(m1Ok + m1Partial + m1Todo).toBe(m1Total);
    expect(m1Partial + m1Todo).toBeGreaterThan(0);
    const readmeProgress = readmeM1![0];
    // 합계를 보존한 채 ✅ 하나를 늘린 거짓 집계: 🟨가 있으면 🟨에서, 없으면 ⬜에서 하나 옮긴다.
    const fake = m1Partial > 0 ? [m1Ok + 1, m1Partial - 1, m1Todo] : [m1Ok + 1, m1Partial, m1Todo - 1];
    const real = `${m1Ok}/${m1Partial}/${m1Todo}`;
    const fakeAcM1Line = [
      acM1![1],
      acM1![2],
      m1Total,
      acM1![4],
      fake[0],
      acM1![6],
      fake[1],
      acM1![8],
      fake[2],
      acM1![10],
    ].join('');
    const cases: [Partial<Context>, string][] = [
      [
        {
          readme: context.readme.replace(
            '원작 비교 분모 90개, 정본 분모 91개, 전 단계 완료 0개',
            '원작 비교 분모 37개, 정본 분모 37개, 전 단계 완료 37개',
          ),
        },
        'README: 명령 대응표 출력(원작/정본/전 단계 완료) 불일치 (문서 37/37/37, 원장 90/91/0)',
      ],
      [
        { readme: context.readme.replace(readmeM1Line, readmeM1Line.replace(readmeProgress, '통과')) },
        'README M1: AC가 전부 ✅가 아닌데',
      ],
      [
        {
          readme: context.readme.replace(
            readmeM1Line,
            readmeM1Line.replace(readmeProgress, `진행 중 (✅ ${fake[0]} · 🟨 ${fake[1]} · ⬜ ${fake[2]})`),
          ),
        },
        `README M1: ${fake.join('/')}인데 인수조건은 ${real}이다`,
      ],
      [
        {
          phases: context.phases.replace(
            'AC-M1-14는 전체 명령 수용 관문으로 바뀌어 🟨로 돌아갔고 M1도 이 행이 ✅가 될 때까지 통과하지 않는다.',
            'AC-M1-14는 37개 전부 완료, M1 통과다.',
          ),
        },
        '단계 계획: AC-M1이 전부 ✅가 아닌데 M1 통과라고 적었다',
      ],
      [
        { phases: context.phases.replace('T1-08 완료는 37개 부분집합 기준', 'T1-08 완료는 36개 부분집합 기준') },
        '단계 계획: T1-08 부분집합 표기 불일치',
      ],
      [
        {
          acceptance: context.acceptance
            .split('\n')
            .map((line) =>
              line.startsWith('| AC-M1-14 ')
                ? line
                    .replace('| 🟨 |', '| ✅ |')
                    .replace('정본 분모 91(명령 88 + 미해결 원본 3), 전 단계 완료 0', '정본 분모 37, 전 단계 완료 37')
                : line,
            )
            .join('\n'),
        },
        '인수조건 AC-M1-14: 남은 행이 있는데 ✅다 (전 단계 완료 0/91)',
      ],
      [
        {
          acceptance: context.acceptance.replace(
            'MVP의 모든 명령이 완료된다. core2026 `df6c926`의 원본 90개(장수 55·국가 35)',
            'MVP 명령 37개가 완료된다. core2026 `df6c926`의 원본 37개(장수 27·국가 10)',
          ),
        },
        '인수조건 AC-M1-14: 옛 37개 범위가 부분집합 이력 밖에 있다',
      ],
      [
        { acceptance: context.acceptance.replace(acM1Line, fakeAcM1Line) },
        `인수조건 요약: M1가 ${m1Total}/${fake.join('/')}인데 AC 행을 다시 세면 ${m1Total}/${real}이다`,
      ],
      [
        { prd: context.prd.replace('**장수 명령 27개 (M1 부분집합)**', '**장수 명령 27개**') },
        'PRD §6.3: 장수 명령 M1 부분집합 표기 문장이 없다',
      ],
      [
        { prd: context.prd.replace('비교 분모는 core2026 `df6c926`의 90개', '비교 분모는 core2026 `df6c926`의 91개') },
        'PRD §6.3: 비교 분모(합/장수/국가) 불일치 (문서 91/55/35, 원장 90/55/35)',
      ],
      [
        {
          phase2: context.phase2.replace(
            '명령의 완료 판정은 AC-M1-14와 [명령 대응표]',
            '명령의 완료 판정은 T4 작업과 [명령 대응표]',
          ),
        },
        'Phase 2 명세 §1: 명령 완료 판정이 AC-M1-14와 대응표라는 문장이 없다',
      ],
      [
        {
          phase2: context.phase2.replace(
            '| 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |',
            '| 계획 가능, 계약은 U-19 · Phase 2 |',
          ),
        },
        'Phase 2 명세 §6: T4-05 상태에 MVP 필수 (D-022)가 없다',
      ],
    ];
    for (const [change, message] of cases) {
      // 모든 문서 반례는 실제 원문을 바꿔야 한다. 치환 대상이 사라져 no-op이 되면 여기서 실패한다.
      for (const [key, mutated] of Object.entries(change) as [keyof Context, unknown][]) {
        expect(mutated, `${message}: ${String(key)} 치환이 원문을 바꾸지 않았다`).not.toBe(context[key]);
      }
      expect(errorsOf(table(), withDocs(change))).toContain(message);
    }
    const noTrade = table();
    noTrade.commands = noTrade.commands.filter((command) => command.id !== 'trade');
    expect(errorsOf(noTrade)).toContain(
      'README: 명령 대응표 출력(원작/정본/전 단계 완료) 불일치 (문서 90/91/0, 원장 90/90/0)',
    );
  });

  it('반례: 이유 없는 해당 없음, 증거 없는 partial, 빠진 단계, 없는 증거 파일·승인·AC는 실패한다', () => {
    const doc = table();
    row(doc, 'farm').stages.restart = { status: 'not_applicable', evidence: [] };
    row(doc, 'farm').stages.replay = { status: 'partial', evidence: [] };
    delete row(doc, 'farm').stages.merge;
    row(doc, 'commerce').stages.ui!.evidence.push({ kind: 'test', ref: 'tools/없는-시험.test.ts' });
    row(doc, 'nation_peace').approvalRefs.push('D-999');
    row(doc, 'trade').acIds.push('AC-M9-99');
    const errors = errorsOf(doc);
    expect(errors).toContain('commands[farm].restart: not_applicable에는 이유가 있어야 한다');
    expect(errors).toContain('commands[farm].replay: partial에는 증거가 하나 이상 있어야 한다');
    expect(errors).toContain('commands[farm].merge: 단계가 빠졌다');
    expect(errors).toContain('증거 파일 tools/없는-시험.test.ts가 없다');
    expect(errors).toContain('commands[nation_peace]: 승인 근거 D-999가 문서에 없다');
    expect(errors).toContain('commands[trade]: AC AC-M9-99가 인수조건·Phase 2 명세에 없다');
  });

  it('반례: 고친 대응표 파일도 CLI 기본 실행과 --verify-git이 1로 끝난다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
    const removed = table();
    removed.commands = removed.commands.filter((command) => command.id !== 'attack');
    writeFileSync(join(dir, 'removed.json'), JSON.stringify(removed));
    const result = main(['--file', join(dir, 'removed.json')], { root });
    expect(result.code).toBe(1);
    expect(result.output).toContain('registry key attack(general)가 대응표에 없다');
    const fake = table();
    row(fake, 'farm').stages.ui = {
      status: 'verified',
      evidence: [
        { kind: 'ci', ref: RUN(1) },
        { kind: 'doc', ref: 'docs/plans/T1-05.md', sha: 'ab6f803bfcefac4907d7fb9b87eae4fd7740934d' },
      ],
    };
    writeFileSync(join(dir, 'fake.json'), JSON.stringify(fake));
    const verified = main(['--file', join(dir, 'fake.json'), '--verify-git'], { root });
    expect(verified.code).toBe(1);
    expect(verified.output).toContain('commands[farm].ui: verified는 독립 리뷰 기록(review)과 같은 SHA의 실행(ci)');
  });

  it('리뷰 절 앵커는 GitHub 제목 규칙으로 찾고 다음 같은 수준 제목에서 끝난다', () => {
    const text = '# T\n## 리뷰 (Claude)\n- 결과: 통과\n### 재리뷰 (Claude, 2026-10-21)\n- b\n## 다음\n- c';
    expect(findSection(text, '리뷰-claude')).toBe(
      '## 리뷰 (Claude)\n- 결과: 통과\n### 재리뷰 (Claude, 2026-10-21)\n- b',
    );
    expect(findSection(text, '재리뷰-claude-2026-10-21')).toBe('### 재리뷰 (Claude, 2026-10-21)\n- b');
    expect(findSection(text, '없는-절')).toBeNull();
  });
});

describe('전체 완료 게이트 (합성 저장소)', () => {
  // 합성 저장소: 원본 1개·명령 1개. 리뷰 절이 전체 SHA·실행 번호·통과를 적고 고정 기준이 그 기록의 범위를 정한다.
  const sha = 'c'.repeat(40);
  const runId = '123456789';
  const reviewDoc = `# T1-08\n## 리뷰\n- 결과: 통과. 검토한 SHA는 \`${sha}\`다.\n- 실행: [CI](${RUN(runId)})\n`;
  const baseline = () => ({
    referenceRevision: { commit: 'b'.repeat(40), general: { ids: ['che_농지개간'] }, nation: { ids: [] } },
    approvedChanges: [],
    verificationRecords: [
      {
        id: 'synthetic',
        review: 'docs/plans/T1-08.md#리뷰',
        sha,
        runs: [{ id: runId, headSha: sha, conclusion: 'success' }],
        stages: STAGES.filter((stage: string) => stage !== 'restart'),
        commands: ['farm'],
      },
    ],
  });
  const docs = (complete: boolean): Partial<Context> => {
    const mark = complete ? '✅' : '🟨';
    const done = complete ? 1 : 0;
    const gate = complete ? '통과' : `진행 중 (✅ 0 · 🟨 1 · ⬜ 0)`;
    return {
      acceptance: [
        '## 요약',
        '| 관문 | 전체 | ✅ | 🟨 | ⬜ |',
        `| M1 a | 1 | ${done} | ${1 - done} | 0 |`,
        '| M2 a | 1 | 1 | 0 | 0 |',
        '| M3 a | 1 | 1 | 0 | 0 |',
        '## M1',
        `| AC-M1-14 | MVP의 모든 명령이 완료된다. core2026 \`bbbbbbb\`의 원본 1개(장수 1·국가 0)마다 command-coverage.json | 검사 | ${mark} | 전체 명령: ${complete ? '완료' : '미완료'}. 정본 분모 1(명령 1 + 미해결 원본 0), 전 단계 완료 ${done} |`,
        '| AC-M2-01 | a | a | ✅ | a |',
        '| AC-M3-01 | a | a | ✅ | a |',
      ].join('\n'),
      readme: [
        `| M1 a | [AC-M1 1개](x) 통과 | ${gate} |`,
        '| M2 a | [AC-M2 1개](x) 통과 | 통과 |',
        '| M3 a | [AC-M3 1개](x) 통과 | 통과 |',
        `command-coverage.json 원작 비교 분모 1개, 정본 분모 1개, 전 단계 완료 ${done}개`,
      ].join('\n'),
      prd: '장수 명령 1개, 국가 명령 0개. MVP는 모든 명령을 완료한다. 비교 분모는 core2026 `bbbbbbb`의 1개(장수 1, 국가 0)다. command-coverage.json\n**장수 명령 1개 (M1 부분집합)**\n**국가 명령 0개 (M1 부분집합):**',
      phases: `| T1-08 | a | M1-14 | Codex | — | 완료 |\nAC-M1-14는 전체 명령 수용 관문으로 바뀌어 ${mark}로 돌아갔고 M1도 이 행이 ✅가 될 때까지 통과하지 않는다. T1-08 완료는 1개 부분집합 기준\n2026-10-22 D-022로 이 명령들은 MVP 필수가 됐다`,
      phase2: '명령의 완료 판정은 AC-M1-14와 [명령 대응표]',
      index: 'command-coverage.json command-coverage-baseline.json',
    };
  };
  const synthetic = (complete: boolean, change: Partial<Context> = {}): Context =>
    withDocs({
      registry: [{ key: 'farm', target: 'general' }],
      baseline: baseline(),
      readDoc: (path: string) => (path === 'docs/plans/T1-08.md' ? reviewDoc : ''),
      ...docs(complete),
      ...change,
    });
  const evidence = (): Evidence[] => [
    { kind: 'review', ref: 'docs/plans/T1-08.md#리뷰', sha },
    { kind: 'ci', ref: RUN(runId), sha },
  ];
  const makeDoc = () => {
    const stages: Record<string, Stage> = Object.fromEntries(
      STAGES.map((stage: string) => [
        stage,
        stage === 'restart'
          ? { status: 'not_applicable', evidence: [], reason: '시험용 이유' }
          : { status: 'verified', evidence: evidence() },
      ]),
    );
    return {
      version: 1,
      sourceRevision: 'a'.repeat(40),
      ownerDirective: '시험',
      referenceRevision: { commit: 'b'.repeat(40) },
      referenceCommands: [{ id: 'general:che_농지개간', target: 'general', source: 'x' }],
      unresolvedReferences: [],
      commands: [
        {
          id: 'farm',
          target: 'general',
          sourceIds: ['general:che_농지개간'],
          replacementReason: null,
          approvalRefs: [],
          acIds: [],
          queueIds: [],
          ownerProfile: 'opensamguk-implement',
          reviewerProfile: 'opensamguk-review',
          paths: [],
          blockers: [],
          stages,
        },
      ],
    };
  };

  it('모든 단계가 검증 기록으로 확인되면 0, 하나라도 남으면 1이고 문서도 그 상태와 맞아야 한다', () => {
    const doc = makeDoc();
    const complete = analyze(doc, synthetic(true));
    expect(complete.errors).toEqual([]);
    expect(complete.gaps).toEqual([]);
    expect(exitCode(complete, true)).toBe(0);
    doc.commands[0]!.stages.merge = { status: 'partial', evidence: evidence() };
    expect(analyze(doc, synthetic(true)).errors.join('\n')).toContain('인수조건 AC-M1-14: 남은 행이 있는데 ✅다');
    const open = analyze(doc, synthetic(false));
    expect(open.errors).toEqual([]);
    expect(open.gaps).toHaveLength(1);
    expect(exitCode(open, false)).toBe(0);
    expect(exitCode(open, true)).toBe(1);
  });

  it('합성 저장소에서도 가짜 실행, 짧은 SHA, 다른 SHA의 실행, 실패 실행, 검토 전 리뷰 절은 완료가 아니다', () => {
    const fakeRun = makeDoc();
    fakeRun.commands[0]!.stages.ui = {
      status: 'verified',
      evidence: [
        { kind: 'ci', ref: RUN(1), sha: '0123456' },
        { kind: 'review', ref: 'docs/plans/T1-08.md#리뷰', sha: '0123456' },
      ],
    };
    const fakeErrors = errorsOf(fakeRun as Doc, synthetic(true));
    expect(fakeErrors).toContain('commands[farm].ui: verified 근거의 sha 0123456는 40자리 전체 SHA여야 한다');
    expect(fakeErrors).toContain('commands[farm].ui: 리뷰 근거 docs/plans/T1-08.md#리뷰@0123456가 고정 검증 기록');
    const otherSha = makeDoc();
    otherSha.commands[0]!.stages.ui!.evidence[1]!.sha = 'd'.repeat(40);
    expect(errorsOf(otherSha as Doc, synthetic(true))).toContain(
      `commands[farm].ui: 실행 ${runId}의 SHA가 검증 기록 SHA와 다르다`,
    );
    const failedBaseline = baseline();
    failedBaseline.verificationRecords[0]!.runs[0]!.conclusion = 'failure';
    expect(errorsOf(makeDoc() as Doc, synthetic(true, { baseline: failedBaseline }))).toContain(
      `검증 기록 synthetic: 실행 ${runId}의 결과가 success가 아니다 (failure)`,
    );
    const pending = synthetic(true, {
      readDoc: () => `# T1-08\n## 리뷰\n- 결과: 리뷰 대기. 대상 \`${sha}\`, [CI](${RUN(runId)})\n`,
    });
    expect(errorsOf(makeDoc() as Doc, pending)).toContain('검증 기록 synthetic: 리뷰 절의 결과가 통과가 아니다');
    const silent = synthetic(true, { readDoc: () => '# T1-08\n## 리뷰\n- 결과: 통과\n' });
    const silentErrors = errorsOf(makeDoc() as Doc, silent);
    expect(silentErrors).toContain(`검증 기록 synthetic: 리뷰 절이 전체 SHA ${sha}를 적지 않았다`);
    expect(silentErrors).toContain(`검증 기록 synthetic: 리뷰 절이 실행 ${runId}를 적지 않았다`);
  });
});
