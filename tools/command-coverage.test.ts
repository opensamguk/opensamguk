import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
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
  verifyGitShas,
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
const runCli = (...args: string[]) =>
  spawnSync(process.execPath, ['tools/command-coverage.mjs', ...args], { cwd: root, encoding: 'utf8' });

describe('T4-02 등록된 확장 명령 대조', () => {
  const fixture = (files: Record<string, string>, run: (dir: string) => void, parent = tmpdir()) => {
    const dir = mkdtempSync(join(parent, 'coverage-ext-'));
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
  const actualSupport = () =>
    Object.fromEntries(
      [
        'support.ts',
        '../balance.ts',
        '../model/clone.ts',
        'ext/state.ts',
        '../personnel/permissions.ts',
        '../personnel/types.ts',
      ].map((file) => [file, readFileSync(join(root, 'packages/rules/src/commands', file), 'utf8')]),
    );
  const importWithTsx = (dir: string, expression: string) => {
    const file = pathToFileURL(join(dir, 'packages/rules/src/commands/ext/registry.ts')).href;
    const runtime = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const {extensionCommands}=await import(${JSON.stringify(file)}); console.log(JSON.stringify(${expression}));`,
      ],
      { encoding: 'utf8' },
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    return JSON.parse(runtime.stdout);
  };
  const emptyLegacyRegistry = (dir: string) => {
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
  };

  const stratagemFixture = () => ({
    ...actualSupport(),
    ...Object.fromEntries(
      [
        'ext/registry.ts',
        'ext/stratagem/index.ts',
        'ext/stratagem/base.ts',
        'ext/stratagem/fire_attack.ts',
        'ext/stratagem/sabotage.ts',
        'ext/stratagem/incite.ts',
        'ext/stratagem/plunder.ts',
        '../clock/clock.ts',
        '../clock/constants.ts',
        '../general/fiveStats.ts',
      ].map((file) => [
        file,
        readFileSync(join(root, 'packages/rules/src/commands', file), 'utf8').replaceAll('\r\n', '\n'),
      ]),
    ),
  });

  it('T4-17 실제 계략 import와 정적 목록·인자 검사가 같다', () => {
    fixture(
      stratagemFixture(),
      (dir) => {
        const runtime = importWithTsx(
          dir,
          `extensionCommands.map(def => ({ key: def.key, target: def.target, valid: def.args.safeParse({cityKey:1}).success, invalid: def.args.safeParse({cityKey:0}).success }))`,
        );
        expect(runtime).toEqual(readExtensionRegistryKeys(dir).map((def) => ({ ...def, valid: true, invalid: false })));
        expect(runtime).toHaveLength(4);
      },
      join(root, 'packages/rules'),
    );
  });

  it.each(['factory', 'property-key', 'spec-helper', 'definition-spread', 'zod-default', 'hidden-fifth'])(
    'T4-17 지원 밖 %s를 실행하지 않고 CLI exit 1로 거부한다',
    (kind) => {
      const files = stratagemFixture();
      const base = 'ext/stratagem/base.ts';
      const fire = 'ext/stratagem/fire_attack.ts';
      if (kind === 'factory') {
        files[base] +=
          `\nexport function makeStratagem(spec) { return { key: spec.key, name: spec.name, category: 'strategy', target: 'general', args: stratagemArgs, check: checkStratagem, precheck: checkStratagem, execute: (view, actor, raw, rng) => executeStratagem(spec, view, actor, raw, rng) }; }\n`;
        for (const key of ['fire_attack', 'sabotage', 'incite', 'plunder']) {
          const path = `ext/stratagem/${key}.ts`;
          const spec = files[path]!.match(/export const \w+Spec: StratagemSpec = (\{[\s\S]*?\});/)![1]!;
          files[path] = `import { makeStratagem } from './base';\nexport const ${key} = makeStratagem(${spec});\n`;
        }
      } else if (kind === 'property-key') {
        files[fire] = files[fire]!.replace(
          "export const fire_attack: CommandDef = {\n  key: 'fire_attack',",
          'export const fire_attack: CommandDef = {\n  key: fireAttackSpec.key,',
        );
      } else if (kind === 'spec-helper') {
        files[fire] = files[fire]!.replace(
          /export const fireAttackSpec: StratagemSpec = (\{[\s\S]*?\n\});/,
          "const make = (key) => ($1);\nexport const fireAttackSpec = make('fire_attack');",
        );
      } else if (kind === 'definition-spread') {
        files['ext/stratagem/sabotage.ts'] = files['ext/stratagem/sabotage.ts']!.replace(
          'export const sabotage: CommandDef = {',
          "export const sabotage: CommandDef = { ...{ category: 'strategy' },",
        );
      } else if (kind === 'zod-default') {
        files[base] = files[base]!.replace('cityKey: positive', 'cityKey: positive.default(1)');
      } else {
        files[base] += "\nexport function makeHidden(key) { return { key, target: 'general' }; }\n";
        files['ext/stratagem/index.ts'] =
          "import { makeHidden } from './base';\n" +
          files['ext/stratagem/index.ts']!.replace(
            '[fire_attack, sabotage, incite, plunder]',
            "[fire_attack, sabotage, incite, plunder, makeHidden('hidden_command')]",
          );
      }
      fixture(
        files,
        (dir) => {
          if (kind === 'factory' || kind === 'hidden-fifth') {
            const runtime = importWithTsx(dir, 'extensionCommands.map(({key,target}) => ({key,target}))');
            expect(runtime).toEqual([
              ...extensionCommands.map(({ key, target }) => ({ key, target })),
              ...(kind === 'hidden-fifth' ? [{ key: 'hidden_command', target: 'general' }] : []),
            ]);
          }
          expect(() => readExtensionRegistryKeys(dir)).toThrow(
            kind === 'factory' ? '선언 makeStratagem을 찾지 못했다' : undefined,
          );
          emptyLegacyRegistry(dir);
          const result = main(['--root', dir, '--file', tablePath]);
          expect(result.code).toBe(1);
          expect(result.output).toContain('registry를 읽지 못했다');
        },
        join(root, 'packages/rules'),
      );
    },
  );

  it('실제 permissions.ts의 동결 표와 빈 Error 클래스를 실제 import 목록과 대조한다', () => {
    fixture(
      stratagemFixture(),
      (dir) => {
        const path = join(dir, 'packages/rules/src/personnel/permissions.ts');
        const url = JSON.stringify(pathToFileURL(path).href);
        const runtime = importWithTsx(
          dir,
          '({registry: extensionCommands.map(({key,target})=>({key,target})),' +
            'frozen: Object.isFrozen((await import(' +
            url +
            ')).NATION_COMMAND_PERMISSIONS),' +
            'appointable: (await import(' +
            url +
            ')).APPOINTABLE_OFFICER_LEVELS})',
        );
        expect(runtime.registry).toEqual(extensionCommands.map(({ key, target }) => ({ key, target })));
        expect(readExtensionRegistryKeys(dir)).toEqual(runtime.registry);
        expect(runtime.frozen).toBe(true);
        expect(runtime.appointable).toEqual([11, 10, 9, 8, 7, 6, 5]);
        expect(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).toBe(
          readFileSync(join(root, 'packages/rules/src/personnel/permissions.ts'), 'utf8').replaceAll('\r\n', '\n'),
        );
      },
      join(root, 'packages/rules'),
    );
  });

  it('닫힌 동결 표의 별칭·Set·읽기 전용 콜백은 실제 계산과 같다', () => {
    const source = [
      "const none = Object.freeze([] as const); const base = Object.freeze(['a','b'] as const);",
      "const wide = Object.freeze([...base, 'c'] as const);",
      'export const ROLES = Object.freeze([',
      'Object.freeze({levels:Object.freeze([2] as const),lead:true,keys:wide}),',
      'Object.freeze({levels:Object.freeze([1,0] as const),lead:false,keys:base}),',
      'Object.freeze({levels:Object.freeze([9] as const),lead:false,keys:none})] as const);',
      'const keys = [...new Set(ROLES.flatMap<string>(role => role.keys))];',
      'export const TABLE = Object.freeze(Object.fromEntries(keys.map(key => [key,',
      'Object.freeze(ROLES.filter(role => role.keys.some(item => item === key)).flatMap<number>(role => role.levels))])));',
      'export const PICKED = Object.freeze(ROLES.filter(role => !role.lead && role.keys.length > 0).flatMap<number>(role => role.levels));',
      'export function lookup(key: string) { return TABLE[key as keyof typeof TABLE]; }',
    ].join('\n');
    fixture(
      {
        'ext/definitions.ts': 'export const list = [' + command('fire_attack') + '];',
        '../../package.json': '{"type":"module"}',
        'ext/table.ts': source,
        'ext/registry.ts':
          "import {lookup} from './table.ts'; export {list as extensionCommands} from './definitions.ts';",
      },
      (dir) => {
        const url = JSON.stringify(pathToFileURL(join(dir, 'packages/rules/src/commands/ext/table.ts')).href);
        const runtime = importWithTsx(
          dir,
          '({registry:extensionCommands, table:(await import(' +
            url +
            ')).TABLE, picked:(await import(' +
            url +
            ')).PICKED})',
        );
        expect(runtime.table).toEqual({ a: [2, 1, 0], b: [2, 1, 0], c: [2] });
        expect(runtime.picked).toEqual([1, 0]);
        expect(runtime.registry).toEqual([{ key: 'fire_attack', target: 'general' }]);
        expect(readExtensionRegistryKeys(dir)).toEqual(runtime.registry);
      },
    );
  });

  it.each([
    ['중첩 push', 'const t = Object.freeze([list.push(hidden)]);'],
    ['콜백 push', 'const t = Object.freeze(roles.map(role => list.push(hidden)));'],
    ['캡처 별칭 변경', 'const target = list; const t = Object.freeze(roles.map(role => target.push(hidden)));'],
    ['helper 호출', 'const add = () => list.push(hidden); const t = Object.freeze(roles.flatMap(role => add()));'],
    ['블록 콜백', 'const t = Object.freeze(roles.map(role => { list.push(hidden); return role; }));'],
    ['접근자', 'const t = Object.freeze([{get keys() { list.push(hidden); return []; }}].flatMap(role => role.keys));'],
    ['계산 속성', 'const t = Object.freeze({[list.push(hidden)]:1});'],
    ['모르는 Object 함수', 'const t = Object.freeze(Object.assign(list,{1:hidden}));'],
    ['모르는 내장 콜백', 'const t = Object.freeze(Array.from(roles,() => list.push(hidden)));'],
    [
      'Object 가림',
      'const Object = {freeze:(value:unknown) => (list.push(hidden),value)}; const t = Object.freeze([]);',
    ],
    ['Set 가림', 'function Set(value:unknown) { list.push(hidden); return value; } const t = [...new Set(roles)];'],
    ['키 형 변환', "const t = Object.fromEntries([[{toString() { list.push(hidden); return 'k'; }},1]]);"],
    ['클래스 static 블록', 'class Err extends Error {static {list.push(hidden);}}'],
    ['클래스 static 필드', 'class Err extends Error {static changed = list.push(hidden);}'],
    ['클래스 계산 키', 'class Err extends Error {[list.push(hidden)]() {}}'],
    ['상속 식 실행', 'class Err extends (list.push(hidden),Error) {}'],
  ])('동결 자료 %s의 숨은 등록은 실제로 생기고 정적 도구와 CLI는 거부한다', (name, code) => {
    const roles =
      name === 'Object 가림'
        ? ''
        : "const roles = Object.freeze([Object.freeze({keys:Object.freeze(['a'] as const)})]);";
    fixture(
      {
        'ext/definitions.ts':
          'export const list = [' +
          command('fire_attack') +
          ']; export const hidden = ' +
          command('hidden_command') +
          ';',
        '../../package.json': '{"type":"module"}',
        'ext/table.ts': "import {list,hidden} from './definitions.ts'; " + roles + ' export const unused = 0; ' + code,
        'ext/registry.ts':
          "import {unused} from './table.ts'; export const dependency = unused; export {list as extensionCommands} from './definitions.ts';",
      },
      (dir) => {
        const runtime = importWithTsx(dir, 'extensionCommands');
        expect(runtime[0]).toEqual({ key: 'fire_attack', target: 'general' });
        expect(runtime.length).toBeGreaterThan(1);
        expect(runtime.slice(1)).toEqual(
          Array.from({ length: runtime.length - 1 }, () => ({ key: 'hidden_command', target: 'general' })),
        );
        expect(() => readExtensionRegistryKeys(dir)).toThrow(/ext[\\/]table\.ts/);
        emptyLegacyRegistry(dir);
        const result = main(['--root', dir, '--file', tablePath]);
        expect(result.code).toBe(1);
        expect(result.output).toContain('registry를 읽지 못했다: 확장 registry');
      },
    );
  });

  it('실제 permissions.ts 콜백의 숨은 등록을 실제 실행과 대조해 거부한다', () => {
    const files: Record<string, string> = {
      ...actualSupport(),
      'ext/definitions.ts':
        'export const list = [' +
        command('fire_attack') +
        ']; export const hidden = ' +
        command('hidden_command') +
        ';',
      'ext/registry.ts':
        "import {defineCommand} from '../support.ts'; export const dependency = defineCommand; export {list as extensionCommands} from './definitions.ts';",
    };
    files['../personnel/permissions.ts'] =
      "import {list,hidden} from '../commands/ext/definitions.ts';\n" +
      files['../personnel/permissions.ts'] +
      '\nconst changed = Object.freeze(OFFICER_ROLES.map(role => list.push(hidden)));\n';
    fixture(
      files,
      (dir) => {
        const runtime = importWithTsx(dir, 'extensionCommands');
        expect(runtime[0]).toEqual({ key: 'fire_attack', target: 'general' });
        expect(runtime.length).toBeGreaterThan(1);
        expect(runtime.slice(1)).toEqual(
          Array.from({ length: runtime.length - 1 }, () => ({ key: 'hidden_command', target: 'general' })),
        );
        expect(() => readExtensionRegistryKeys(dir)).toThrow(/personnel[\\/]permissions\.ts/);
        emptyLegacyRegistry(dir);
        const result = main(['--root', dir, '--file', tablePath]);
        expect(result.code).toBe(1);
        expect(result.output).toContain('permissions.ts');
      },
      join(root, 'packages/rules'),
    );
  });

  it.each([
    ['구조 분해 콜백', 'const t = roles.map(({keys}) => keys);'],
    ['콜백 기본값', 'const t = roles.map((role = roles) => role);'],
    ['콜백 나머지', 'const t = roles.map((...role) => role);'],
    ['콜백 매개변수 둘', 'const t = roles.map((role,index) => index);'],
    ['function 콜백', 'const t = roles.map(function(role) {return role;});'],
    ['async 콜백', 'const t = roles.map(async role => role);'],
    ['매개변수 Object 가림', 'const t = roles.map(Object => Object.freeze([]));'],
    ['import Object 가림', 'const t = Object.freeze([]);'],
    ['상속 속성', 'const t = roles.map(role => role.constructor);'],
    ['__proto__ 키', 'const t = Object.freeze({__proto__:roles});'],
    ['배열 원소 접근', 'const t = roles.map(role => role.keys[0]);'],
    ['배열 메서드 값', 'const t = roles.map(role => role.keys.at);'],
    ['모르는 배열 메서드', 'const t = roles.find(role => role);'],
    ['optional 수신자', 'const t = roles?.map(role => role);'],
    ['optional 호출', 'const t = roles.map?.(role => role);'],
    ['객체 비교', 'const t = roles.filter(role => role.keys === role.keys);'],
    ['숫자 아닌 비교', 'const t = roles.filter(role => role.keys > 0);'],
    ['모르는 연산자', 'const t = roles.filter(role => role.n == 1);'],
    ['함수 값 자료', 'const t = Object.freeze([() => 1]);'],
    ['배열 빈칸', "const t = Object.freeze([,'a']);"],
    ['인자 spread', 'const t = Object.freeze(...[roles]);'],
    ['globalThis 경유', 'const t = globalThis.Object.freeze([]);'],
    ['순환', 'const a = Object.freeze([...b]); const b = Object.freeze([...a]);'],
    ['let 별칭', "let data = ['a']; const t = Object.freeze(data.map(item => item));"],
    ['실행 안 된 콜백', 'const t = Object.freeze([].map(item => item));'],
    ['실행 안 된 조건 오른쪽', 'const t = roles.filter(role => false && role.keys.at);'],
    ['닫힌 자료의 zod', "import {z} from 'zod'; const t = Object.freeze([z.string()]);"],
    ['Set 객체 동일성', 'const a = {}; const t = Object.freeze([...new Set([a,a])]);'],
    ['Error 가림', 'function Error() {} class Err extends Error {}'],
    ['상속 함수 호출', 'const make = () => Error; class Err extends make() {}'],
    ['decorator', 'const dec = (value:unknown) => value; @dec class Err extends Error {}'],
    ['default 클래스', 'export default class extends Error {}'],
  ])('닫힌 자료의 지원 밖 %s은 실패한다', (name, source) => {
    const imports =
      name === 'import Object 가림'
        ? "import {tools as Object} from './hooks.ts';"
        : "import {tools} from './hooks.ts';";
    fixture(
      {
        'ext/hooks.ts': 'export const tools = {freeze:(value:unknown) => value};',
        'ext/registry.ts':
          imports +
          "const roles = Object.freeze([Object.freeze({keys:Object.freeze(['a'] as const),n:1})]);" +
          source +
          ' export const extensionCommands = [];',
      },
      (dir) => expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry'),
    );
  });

  it('운영 확장 목록의 key·target이 실제 extensionCommands와 순서까지 같다', () => {
    expect(readExtensionRegistryKeys(root)).toEqual(extensionCommands.map(({ key, target }) => ({ key, target })));
  });

  it('실제 import 별칭·재수출·const 별칭·배열 참조와 spread만 따라가고 미등록 이웃 정의는 빼놓는다', () => {
    fixture(
      {
        'ext/registry.ts': `import type { Missing } from 'not-installed';
        export type { Missing } from './not-referenced.ts';
        import { registered as chosen } from './barrel.ts';
        const alias = chosen; const local = [...alias];
        function mutateLater() { local.push(${command('deferred_command')}); }
        const delayed = () => local.push(${command('deferred_command')});
        export const extensionCommands = ([...local] as const) satisfies readonly unknown[];`,
        'ext/barrel.ts': `export { active as registered } from './definitions.ts';`,
        'ext/definitions.ts': `const first = ${command('fire_attack')};
        export const unusedSibling = ${command('never_registered')};
        export const active = [first, ${command('nation_research_fire_wheel', 'nation')}];`,
        'ext/not-referenced.ts': 'this file is not valid TypeScript @',
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
        expect(readExtensionRegistryKeys(dir).map(({ key }: { key: string }) => key)).not.toContain('never_registered');
      },
    );
  });

  it.each([
    [
      '부작용 import',
      {
        'ext/registry.ts': `import './register.ts'; export { list as extensionCommands } from './definitions.ts';`,
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];`,
        'ext/register.ts': `import { list } from './definitions.ts'; list.push(${command('hidden_command')});`,
      },
    ],
    [
      '참조하지 않은 const 초기값',
      {
        'ext/registry.ts': `import { list } from './definitions.ts'; export const extensionCommands = list;`,
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];
        const changed = list.push(${command('hidden_command')});`,
      },
    ],
    [
      'class static block',
      {
        'ext/registry.ts': `import { list } from './definitions.ts'; export const extensionCommands = list;`,
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];
        class Register { static { list.push(${command('hidden_command')}); } }`,
      },
    ],
    [
      'registry 자체의 const 초기값',
      {
        'ext/registry.ts': `const list = [${command('fire_attack')}];
        const changed = list.push(${command('hidden_command')}); export const extensionCommands = list;`,
      },
    ],
    [
      '사용하지 않는 named import의 모듈 초기화',
      {
        'ext/registry.ts': `import { unused } from './register.ts'; export { list as extensionCommands } from './definitions.ts';`,
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];`,
        'ext/register.ts': `import { list } from './definitions.ts';
        export const unused = list.push(${command('hidden_command')});`,
      },
    ],
    [
      'class static 필드 초기값',
      {
        'ext/registry.ts': `export const extensionCommands = [${command('fire_attack')}];
        class Register { static changed = extensionCommands.push(${command('hidden_command')}); }`,
      },
    ],
  ] satisfies [string, Record<string, string>][])(
    '%s의 숨은 등록은 실제로 실행되지만 정적 도구와 CLI는 거부한다',
    (_name, files) => {
      fixture(files, (dir) => {
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
        expect(JSON.parse(runtime.stdout)).toEqual([
          { key: 'fire_attack', target: 'general' },
          { key: 'hidden_command', target: 'general' },
        ]);
        expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry');
        emptyLegacyRegistry(dir);
        const result = main(['--root', dir, '--file', tablePath]);
        expect(result.code).toBe(1);
        expect(result.output).toContain('registry를 읽지 못했다: 확장 registry');
      });
    },
  );

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

  it('실제 support.ts와 zod 인자 스키마를 쓰는 장수·국가 명령을 실제 import와 대조한다', () => {
    const spec = `name: '시험', category: 'strategy',
      args: schema.strictObject({cityKey: positive, kind: schema.enum(['gold', 'rice']).optional()}),
      check() { return null; }, change() { return {logs: []}; }`;
    fixture(
      {
        ...actualSupport(),
        'ext/actions.ts': `import { z as schema } from 'zod';
        import { defineCommand as define, positive } from '../support.ts';
        export const first = define({key: 'fire_attack', ${spec}});
        export const second = define({key: 'nation_research_fire_wheel', target: 'nation', ${spec}});`,
        'ext/registry.ts': `import {first, second} from './actions.ts'; export const extensionCommands = [first, second];`,
      },
      (dir) => {
        const runtime = importWithTsx(
          dir,
          `({registry: extensionCommands.map(({key,target})=>({key,target})),
          valid: extensionCommands[0].args.safeParse({cityKey:1,kind:'rice'}).success,
          invalid: extensionCommands[0].args.safeParse({cityKey:0,kind:'other'}).success})`,
        );
        expect(runtime.valid).toBe(true);
        expect(runtime.invalid).toBe(false);
        expect(readExtensionRegistryKeys(dir)).toEqual(runtime.registry);
        expect(runtime.registry).toEqual([
          { key: 'fire_attack', target: 'general' },
          { key: 'nation_research_fire_wheel', target: 'nation' },
        ]);
      },
      join(root, 'packages/rules'),
    );
  });

  it('실제 support→clone→state 아래 모듈의 숨은 등록도 실제 실행과 대조해 거부한다', () => {
    const common = actualSupport();
    fixture(
      {
        ...common,
        'ext/state.ts': `import {unused} from './hidden.ts'; export const loaded = unused;\n${common['ext/state.ts']}`,
        'ext/registry.ts': `import {defineCommand} from '../support.ts';
        export const dependency = defineCommand;
        export {list as extensionCommands} from './definitions.ts';`,
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];`,
        'ext/hidden.ts': `import {list} from './definitions.ts';
        export const unused = list.push(${command('hidden_command')});`,
      },
      (dir) => {
        expect(importWithTsx(dir, 'extensionCommands')).toEqual([
          { key: 'fire_attack', target: 'general' },
          { key: 'hidden_command', target: 'general' },
        ]);
        expect(() => readExtensionRegistryKeys(dir)).toThrow(/ext[\\/]hidden.ts/);
        emptyLegacyRegistry(dir);
        const result = main(['--root', dir, '--file', tablePath]);
        expect(result.code).toBe(1);
        expect(result.output).toContain('hidden.ts');
      },
      join(root, 'packages/rules'),
    );
  });

  it.each([
    ['enum의 toString', `z.enum([{toString() { list.push(hidden); return 'gold'; }} as any])`],
    ['length의 valueOf', `z.array(z.string()).length({valueOf() { list.push(hidden); return 1; }} as any)`],
  ])('zod %s 형 변환의 숨은 등록을 실제 실행과 대조해 거부한다', (_name, schema) => {
    fixture(
      {
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];
          export const hidden = ${command('hidden_command')};`,
        'ext/registry.ts': `import {z} from 'zod'; import {list, hidden} from './definitions.ts';
          const schema = ${schema}; export {list as extensionCommands} from './definitions.ts';`,
      },
      (dir) => {
        const runtime = importWithTsx(dir, 'extensionCommands');
        expect(runtime[0]).toEqual({ key: 'fire_attack', target: 'general' });
        expect(runtime.slice(1).length).toBeGreaterThan(0);
        expect(runtime.slice(1).every((entry: { key: string }) => entry.key === 'hidden_command')).toBe(true);
        expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry');
        emptyLegacyRegistry(dir);
        const result = main(['--root', dir, '--file', tablePath]);
        expect(result.code).toBe(1);
        expect(result.output).toContain('registry를 읽지 못했다: 확장 registry');
      },
      join(root, 'packages/rules'),
    );
  });

  it.each([
    [
      'const 함수 별칭',
      `const hook = () => { list.push(hidden); return 'gold'; };
      const alias = hook; const schema = z.enum([{toString: alias} as any]);`,
    ],
    ['import 함수 별칭', `const alias = importedHook; const schema = z.enum([{toString: alias} as any]);`],
    ['함수 shorthand', `const toString = importedHook; const schema = z.enum([{toString} as any]);`],
    [
      '배열 별칭과 spread',
      `const item = {toString: importedHook}; const items = [item];
      const alias = items; const schema = z.enum([...alias] as any);`,
    ],
    ['import 객체·배열 별칭', `const alias = importedItems; const schema = z.enum([...alias] as any);`],
    ['객체 spread', `const item = {toString: importedHook}; const schema = z.enum([{...item} as any]);`],
  ])('zod %s 안 함수의 숨은 등록을 실제 실행과 대조해 거부한다', (_name, source) => {
    fixture(
      {
        'ext/definitions.ts': `export const list = [${command('fire_attack')}];
          export const hidden = ${command('hidden_command')};`,
        'ext/hooks.ts': `import {list, hidden} from './definitions.ts';
          export const hook = function () { list.push(hidden); return 'gold'; };
          export const items = [{toString: hook}];`,
        'ext/aliases.ts': `export {hook as convert, items as entries} from './hooks.ts';`,
        'ext/registry.ts': `import {z} from 'zod'; import {list, hidden} from './definitions.ts';
          import {convert as importedHook, entries as importedItems} from './aliases.ts';
          ${source} export {list as extensionCommands} from './definitions.ts';`,
      },
      (dir) => {
        expect(importWithTsx(dir, 'extensionCommands')).toEqual([
          { key: 'fire_attack', target: 'general' },
          { key: 'hidden_command', target: 'general' },
        ]);
        expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry');
        emptyLegacyRegistry(dir);
        expect(main(['--root', dir, '--file', tablePath]).code).toBe(1);
      },
      join(root, 'packages/rules'),
    );
  });

  it.each([
    `z.literal(() => 1)`,
    `z.literal(function () { return 1; })`,
    `z.literal({nested: [() => 1]} as any)`,
    `z.literal({get value() { return 1; }} as any)`,
    `z.literal({set value(input) {} } as any)`,
    `z.literal({get toString() { return () => 'gold'; }} as any)`,
    `z.literal({set toString(input) {} } as any)`,
    `z.literal({convert() { return 1; }} as any)`,
  ])('zod 인자의 함수·중첩 함수·접근자를 거부한다: %s', (schema) => {
    fixture(
      { 'ext/registry.ts': `import {z} from 'zod'; const schema = ${schema}; export const extensionCommands = [];` },
      (dir) => expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry'),
    );
  });

  it('zod 인자의 const·import 별칭과 함수 없는 객체·배열은 실제 스키마와 대조한다', () => {
    fixture(
      {
        ...actualSupport(),
        'ext/values.ts': `export const choices = ['gold', 'rice'] as const; export const limit = 1;`,
        'ext/aliases.ts': `export {choices as kinds, limit as minimum} from './values.ts';`,
        'ext/registry.ts': `import {z as schema} from 'zod';
          import {defineCommand, positive} from '../support.ts';
          import {kinds as options, minimum as lower} from './aliases.ts';
          const names = [...options]; const min = lower;
          const fields = {cityKey: positive, kind: schema.enum(names), tags: schema.array(schema.string()).min(min)};
          const args = schema.strictObject(fields);
          export const extensionCommands = [defineCommand({key: 'fire_attack', name: '시험',
            category: 'strategy', args, check() { return null; }, change() { return {logs: []}; }})];`,
      },
      (dir) => {
        const runtime = importWithTsx(
          dir,
          `({registry: extensionCommands.map(({key,target})=>({key,target})),
            valid: extensionCommands[0].args.safeParse({cityKey:1,kind:'gold',tags:['a']}).success,
            invalid: extensionCommands[0].args.safeParse({cityKey:0,kind:'other',tags:[]}).success})`,
        );
        expect(runtime.valid).toBe(true);
        expect(runtime.invalid).toBe(false);
        expect(readExtensionRegistryKeys(dir)).toEqual(runtime.registry);
      },
      join(root, 'packages/rules'),
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
    ['사용하지 않는 외부 import', `import { unused } from 'not-installed'; export const extensionCommands = [];`],
    [
      'zod 인자의 숨은 실행',
      `import {z} from 'zod'; const schema = z.strictObject({x: list.push(1)}); export const extensionCommands = [];`,
    ],
    [
      'zod의 지원하지 않는 실행 API',
      `import {z} from 'zod'; const schema = z.preprocess(() => list.push(1), z.number()); export const extensionCommands = [];`,
    ],
    [
      'Set 이름을 가진 함수',
      `function Set() { list.push(${command('hidden_command')}); }
      const list = []; const value = new Set(['a']); export const extensionCommands = list;`,
    ],
    ['초기값의 객체 속성 실행', `const sibling = { changed: list.push(1) }; export const extensionCommands = [];`],
    ['객체 계산 속성 실행', `const sibling = { [list.push(1)]: 0 }; export const extensionCommands = [];`],
    [
      '객체 접근자 실행',
      `export const extensionCommands = [{ get key() { return 'fire_attack'; }, target: 'general' }];`,
    ],
  ])('%s은 조용히 생략하지 않고 실패한다', (_name, source) => {
    fixture({ 'ext/registry.ts': source }, (dir) => {
      expect(() => readExtensionRegistryKeys(dir)).toThrow('확장 registry');
    });
  });

  it('등록한 확장의 누락·다른 대상·기본 key와 충돌을 실패시키고 기본 37개 집계는 보존한다', () => {
    const registeredCommands = ['fire_attack', 'sabotage', 'incite', 'plunder'].map((key) => command(key)).join(',');
    fixture({ 'ext/registry.ts': `export const extensionCommands = [${registeredCommands}];` }, (dir) => {
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
      const wrongTargetRegistry = extensionRegistry.map((entry: { key: string; target: string }) =>
        entry.key === 'fire_attack' ? { ...entry, target: 'nation' } : entry,
      );
      expect(errorsOf(table(), withDocs({ extensionRegistry: wrongTargetRegistry }))).toContain(
        'commands[fire_attack]: registry target nation와 다르다',
      );
      expect(
        errorsOf(table(), withDocs({ extensionRegistry: [...extensionRegistry, { key: 'farm', target: 'general' }] })),
      ).toContain('확장 registry key farm가 기본·확장 목록과 겹친다');
      writeFileSync(
        join(dir, 'packages/rules/src/commands/ext/registry.ts'),
        `export const extensionCommands = [${registeredCommands},${command('not_in_table')}];`,
      );
      expect(errorsOf(table(), withDocs({ extensionRegistry: readExtensionRegistryKeys(dir) }))).toContain(
        'registry key not_in_table(general)가 대응표에 없다',
      );
    });
  });

  it('등록 표현식을 읽지 못하면 CLI도 exit 1로 실패한다', () => {
    fixture({ 'ext/registry.ts': 'export const extensionCommands = createUnknown();' }, (dir) => {
      emptyLegacyRegistry(dir);
      const result = main(['--root', dir, '--file', tablePath]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('registry를 읽지 못했다: 확장 registry');
    });
  });

  it('CRLF로 저장한 문서도 LF 문서와 같은 검증 문맥과 리뷰 절로 읽는다', () => {
    fixture({ 'ext/registry.ts': 'export const extensionCommands = [];' }, (dir) => {
      emptyLegacyRegistry(dir);
      const docs = {
        'README.md': '# 개발\r\n| M1 | 진행 중 |\r\n',
        'docs/product/acceptance-criteria.md': '## 요약\r\n| M1 a | 1 | 0 | 1 | 0 |\r\n',
        'docs/plans/T1-08.md': '## 리뷰 (Claude)\r\n- 결과: 통과\r\n',
      };
      for (const [path, source] of Object.entries(docs)) {
        const file = join(dir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      const loaded = loadContext(dir);
      expect(loaded.readme).toBe('# 개발\n| M1 | 진행 중 |\n');
      expect(loaded.acceptance).toBe('## 요약\n| M1 a | 1 | 0 | 1 | 0 |\n');
      expect(findSection(loaded.readDoc('docs/plans/T1-08.md'), '리뷰-claude')).toBe(
        '## 리뷰 (Claude)\n- 결과: 통과\n',
      );
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
    const plain = runCli();
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(plain.stdout).toContain('대응표 정합: 통과');
    expect(plain.stdout).toContain('제품 전체 완료: 미완료');
    const gate = runCli('--require-complete');
    expect(gate.status).toBe(1);
    expect(gate.stdout).toContain('남음 nation_research_fire_wheel');
    expect(runCli('--모르는').status).toBe(2);
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
    const errors = errorsOf(
      doc,
      withDocs({ extensionRegistry: context.extensionRegistry.filter(({ key }) => key !== 'fire_attack') }),
    );
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
    const ciRef = (owner: string) => {
      const doc = table();
      row(doc, 'farm').stages.engine!.evidence.find((item) => item.kind === 'ci')!.ref =
        `https://github.com/${owner}/opensamguk/actions/runs/39537902044`;
      return errorsOf(doc);
    };
    expect(ciRef('opensamguk')).toBe(errorsOf(table()));
    expect(ciRef('someone')).toContain('의 실행 주소여야 한다');
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
          phase2: context.phase2.replace(/^(\| T4-05 \|[^\n]*) · MVP 필수 \(D-022\)/m, '$1 · Phase 2'),
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

  it('반례: 등록 명령을 뺀 대응표는 함수와 CLI 기본 실행에서 거부한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
    try {
      const removed = table();
      removed.commands = removed.commands.filter((command) => command.id !== 'attack');
      writeFileSync(join(dir, 'removed.json'), JSON.stringify(removed));
      const result = main(['--file', join(dir, 'removed.json')], { root });
      expect(result.code).toBe(1);
      expect(result.output).toContain('registry key attack(general)가 대응표에 없다');
      const plainCli = runCli('--file', join(dir, 'removed.json'));
      expect(plainCli.status, plainCli.stdout + plainCli.stderr).toBe(1);
      expect(plainCli.stdout).toContain('registry key attack(general)가 대응표에 없다');
    } finally {
      expect(dirname(dir)).toBe(normalize(tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('반례: 검증 증거를 꾸민 대응표는 함수와 CLI --verify-git에서 거부한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
    try {
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
      const verifiedCli = runCli('--file', join(dir, 'fake.json'), '--verify-git');
      expect(verifiedCli.status, verifiedCli.stdout + verifiedCli.stderr).toBe(1);
      expect(verifiedCli.stdout).toContain(
        'commands[farm].ui: verified는 독립 리뷰 기록(review)과 같은 SHA의 실행(ci)',
      );
    } finally {
      expect(dirname(dir)).toBe(normalize(tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('반복한 Git 시험 경로의 오류는 단계·참조별로 남고 다음 호출은 다른 저장소를 다시 확인한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-git-'));
    try {
      const config = join(dir, 'empty.gitconfig');
      const hooks = join(dir, 'empty-hooks');
      writeFileSync(config, '');
      mkdirSync(hooks);
      const gitEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: config,
      };
      const git = (repo: string, ...args: string[]) => {
        const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const valid = 'tools/coverage-present.test.ts';
      const missing = ['tools/coverage-missing.test.ts#first', 'tools/coverage-missing.test.ts#second'];
      const makeRepo = (name: string) => {
        const repo = join(dir, name);
        mkdirSync(join(repo, 'tools'), { recursive: true });
        git(repo, 'init', '-q', '--template=');
        git(repo, 'config', '--local', 'user.name', 'coverage fixture');
        git(repo, 'config', '--local', 'user.email', 'coverage-fixture@example.invalid');
        git(repo, 'config', '--local', 'commit.gpgsign', 'false');
        git(repo, 'config', '--local', 'core.hooksPath', hooks);
        git(repo, 'config', '--local', 'core.autocrlf', 'false');
        writeFileSync(join(repo, valid), `// fixture ${name}\n`);
        git(repo, 'add', '--', valid);
        git(repo, 'commit', '-q', '--no-verify', '-m', `fixture ${name}`);
        const sha = git(repo, 'rev-parse', 'HEAD');
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(git(repo, 'ls-tree', '-r', '--name-only', sha)).toBe(valid);
        return { repo, sha };
      };
      const a = makeRepo('a');
      const b = makeRepo('b');
      expect(a.sha).not.toBe(b.sha);
      const doc = (sha: string) => {
        const stage = {
          status: 'verified',
          evidence: [
            { kind: 'review', ref: 'review', sha },
            ...[valid, ...missing].map((ref) => ({ kind: 'test', ref })),
          ],
        };
        return { commands: [{ id: 'farm', stages: { engine: stage, effectsCostsFailures: stage } }] };
      };
      const missingErrors = (sha: string) =>
        ['engine', 'effectsCostsFailures'].flatMap((name) =>
          missing.map((ref) => `commands[farm].${name}: 시험 ${ref}가 검증 SHA ${sha}에 없다`),
        );
      const absentErrors = [
        `증거 SHA ${a.sha}가 저장소에 없다`,
        `commands[farm].engine: 시험 ${valid}가 검증 SHA ${a.sha}에 없다`,
        ...missingErrors(a.sha).slice(0, 2),
        `commands[farm].effectsCostsFailures: 시험 ${valid}가 검증 SHA ${a.sha}에 없다`,
        ...missingErrors(a.sha).slice(2),
      ];
      expect(verifyGitShas(doc(a.sha), a.repo)).toEqual(missingErrors(a.sha));
      expect(verifyGitShas(doc(a.sha), b.repo)).toEqual(absentErrors);
      expect(verifyGitShas(doc(b.sha), b.repo)).toEqual(missingErrors(b.sha));
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      expect(verifyGitShas(doc(a.sha), plain)).toEqual(absentErrors);
      expect(verifyGitShas(doc(a.sha), a.repo)).toEqual(missingErrors(a.sha));
    } finally {
      expect(dirname(dir)).toBe(normalize(tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['\n', '\r\n'])('리뷰 절 앵커는 개행 %j에서도 같은 제목 범위를 찾는다', (newline) => {
    const text = '# T\n## 리뷰 (Claude)\n- 결과: 통과\n### 재리뷰 (Claude, 2026-10-21)\n- b\n## 다음\n- c';
    const source = text.replace(/\n/g, newline);
    expect(findSection(source, '리뷰-claude')).toBe(
      '## 리뷰 (Claude)\n- 결과: 통과\n### 재리뷰 (Claude, 2026-10-21)\n- b',
    );
    expect(findSection(source, '재리뷰-claude-2026-10-21')).toBe('### 재리뷰 (Claude, 2026-10-21)\n- b');
    expect(findSection(source, '없는-절')).toBeNull();
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
      extensionRegistry: [],
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
