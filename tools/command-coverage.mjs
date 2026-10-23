#!/usr/bin/env node
// AC-M1-14 전체 명령 대응표 검사 (D-022).
// 기본 실행은 대응표 정합만 판정하고 남은 일(gap)을 그대로 출력한다.
// --require-complete는 제품 전체 완료 판정이며 남은 일이 하나라도 있으면 실패한다.
//
// 대조 기준은 검사 대상 대응표와 따로 둔 docs/product/command-coverage-baseline.json이다.
// - 원본 ID 전집: 고정 원작 revision에서 뽑은 장수·국가 ID. 대응표의 referenceCommands가 이것과 정확히 같아야 한다.
// - 승인된 추가·대체: 결정(D-xxx)이 승인한 추가 명령과 1:1 대체. 대응표 행과 근거가 이것과 맞아야 한다.
// - 검증 기록: verified를 만들 수 있는 독립 리뷰 기록. 리뷰 문서 절 자체가 전체 SHA, CI 실행 번호, 통과 결과를
//   적고 있어야 하며 기록이 다루는 명령·단계만 verified가 된다.
// verified 근거 계약: 같은 40자리 SHA의 review(검증 기록의 리뷰 절)와 ci(검증 기록의 실행)가 함께 있어야 한다.
// 파일 존재, 무관한 문서 SHA, 기록에 없는 실행은 verified가 아니며 partial이나 missing으로 둔다.
// --verify-git는 SHA가 저장소 커밋인지와 verified 단계의 시험 파일이 그 SHA에 있었는지를 본다.
// --verify-ci는 GitHub API(gh)로 검증 기록의 실행이 그 SHA에서 success로 끝났는지 본다. 네트워크가 필요하다.
// README·PRD·단계 계획·인수조건·Phase 2 명세의 범위·분모·상태·집계는 아래 문장 계약으로 원장과 대조한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

export const STAGES = [
  'ui',
  'api',
  'authorization',
  'engine',
  'effectsCostsFailures',
  'persistence',
  'restart',
  'replay',
  'independentReview',
  'exactShaValidation',
  'merge',
];
export const STATUSES = ['missing', 'partial', 'verified', 'not_applicable'];
export const EVIDENCE_KINDS = ['ci', 'review', 'test', 'commit', 'doc'];
export const BASELINE_PATH = 'docs/product/command-coverage-baseline.json';
const TARGETS = ['general', 'nation'];
const IMPLEMENTATION_STAGES = ['engine', 'effectsCostsFailures'];
const SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RUN = /actions\/runs\/\d+/;
const REPO_RUN = /^https:\/\/github\.com\/peppone-choi\/opensamguk\/actions\/runs\/(\d+)$/;
const REF_TOKEN = /\b([UAG])-(\d{2})\b/g;
const DECISION_TOKEN = /\bD-(\d{3})\b/g;
const GATES = ['M1', 'M2', 'M3'];
const MARKS = ['✅', '🟨', '⬜'];

const REGISTRY_FILES = [
  ['packages/rules/src/commands/domestic/investment.ts', 'general'],
  ['packages/rules/src/commands/rest.ts', 'general'],
  ['packages/rules/src/commands/military.ts', 'general'],
  ['packages/rules/src/commands/attack.ts', 'general'],
  ['packages/rules/src/commands/personnel.ts', 'general'],
  ['packages/rules/src/commands/personal.ts', 'general'],
  ['packages/rules/src/commands/nation.ts', 'nation'],
];

/** registry 원본 파일에서 `key:` 값만 읽는다. 결과는 vitest가 실제 `commands`와 대조한다. */
export function readRegistryKeys(root) {
  const keys = [];
  for (const [file, target] of REGISTRY_FILES) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const line of source.split('\n')) {
      const match = /\bkey:\s*([^,}]+)/.exec(line);
      if (!match || /key:\s*(string|spec\.key)\b/.test(line)) continue;
      for (const quoted of match[1].matchAll(/'([a-z_]+)'/g)) keys.push({ key: quoted[1], target });
    }
  }
  return keys;
}

// 확장 목록의 const·상대 import를 따라간다. 읽는 모듈의 초기화도 검사해 숨은 목록 변경을 거부한다.
export function readExtensionRegistryKeys(root) {
  const entry = resolve(root, 'packages/rules/src/commands/ext/registry.ts');
  const support = resolve(root, 'packages/rules/src/commands/support.ts');
  const modules = new Map();
  const active = new Set();
  // 고정 의존성 zod의 스키마 생성만 신뢰한다. 임의 패키지·콜백 실행 API는 허용하지 않는다.
  const zodConstructors = new Set([
    'strictObject',
    'object',
    'number',
    'string',
    'boolean',
    'enum',
    'literal',
    'array',
  ]);
  const zodMethods = new Set(['int', 'positive', 'nonnegative', 'min', 'max', 'length', 'optional', 'nullable']);
  const fail = (file, message) => {
    throw new Error(`확장 registry ${relative(root, file)}: ${message}`);
  };
  const importFile = (file, specifier) => {
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.'))
      fail(file, '상대 경로 import만 읽을 수 있다');
    const base = resolve(dirname(file), specifier.text);
    const target = [base, `${base}.ts`, join(base, 'index.ts')].find(
      (path) => path.endsWith('.ts') && existsSync(path),
    );
    if (!target) fail(file, `import ${specifier.text} 파일이 없다`);
    return target;
  };
  const moduleAt = (file) => {
    if (modules.has(file)) return modules.get(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) fail(file, 'TypeScript 구문을 읽지 못했다');
    const bindings = new Map();
    const exports = new Map();
    const imports = [];
    const initializers = [];
    const put = (map, name, value) => {
      if (map.has(name)) fail(file, `선언 ${name}이 두 번 있다`);
      map.set(name, value);
    };
    const fromModule = (specifier, name) => ({ specifier, name });
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) fail(file, '부작용 import는 읽을 수 없다');
        if (clause.isTypeOnly) continue;
        // 개별 type import만 있더라도 import {}가 남아 모듈을 초기화할 수 있다.
        imports.push(statement.moduleSpecifier);
        if (clause.name) put(bindings, clause.name.text, fromModule(statement.moduleSpecifier, 'default'));
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named))
          put(bindings, named.name.text, fromModule(statement.moduleSpecifier, '*'));
        if (named && ts.isNamedImports(named))
          for (const item of named.elements)
            if (!item.isTypeOnly)
              put(
                bindings,
                item.name.text,
                fromModule(statement.moduleSpecifier, (item.propertyName ?? item.name).text),
              );
      } else if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) fail(file, '구조 분해 선언은 읽을 수 없다');
          const name = declaration.name.text;
          put(bindings, name, {
            node: declaration.initializer,
            constant: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
          });
          if (declaration.initializer) initializers.push(declaration.initializer);
          if (exported) put(exports, name, { file, name });
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        if (statement.moduleSpecifier) imports.push(statement.moduleSpecifier);
        if (statement.exportClause && ts.isNamedExports(statement.exportClause))
          for (const item of statement.exportClause.elements)
            if (!item.isTypeOnly)
              put(
                exports,
                item.name.text,
                statement.moduleSpecifier
                  ? fromModule(statement.moduleSpecifier, (item.propertyName ?? item.name).text)
                  : { file, name: (item.propertyName ?? item.name).text },
              );
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        put(exports, 'default', { node: statement.expression, constant: true });
        initializers.push(statement.expression);
      } else if (ts.isFunctionDeclaration(statement)) {
        if (statement.name) put(bindings, statement.name.text, { node: statement, constant: false });
      } else if (
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isEmptyStatement(statement)
      ) {
        fail(file, `최상위 실행문 ${ts.SyntaxKind[statement.kind]}은 읽을 수 없다`);
      }
    }
    const result = { bindings, exports };
    modules.set(file, result);
    for (const specifier of imports) {
      if (ts.isStringLiteral(specifier) && specifier.text === 'zod') continue;
      moduleAt(importFile(file, specifier));
    }
    for (const initializer of initializers) pureInitializer(file, initializer);
    return result;
  };
  const binding = (file, name, exported = false) => {
    if (file === support && name === 'defineCommand' && exported) return { factory: true };
    const id = `${file}:${exported ? 'export:' : ''}${name}`;
    if (active.has(id)) fail(file, `순환 참조 ${name}`);
    active.add(id);
    try {
      const found = moduleAt(file)[exported ? 'exports' : 'bindings'].get(name);
      if (!found) fail(file, `선언 ${name}을 찾지 못했다`);
      if (found.specifier) {
        if (ts.isStringLiteral(found.specifier) && found.specifier.text === 'zod') {
          if (found.name === 'z') return { zodRoot: true };
          fail(file, `zod의 ${found.name} 바인딩은 읽을 수 없다`);
        }
        return binding(importFile(file, found.specifier), found.name, true);
      }
      if (found.file) return binding(found.file, found.name, found.exported);
      if (!found.constant || !found.node) fail(file, `${name}은 초기값이 있는 const여야 한다`);
      return value(file, found.node);
    } finally {
      active.delete(id);
    }
  };
  const zodValue = (file, node) => {
    if (ts.isIdentifier(node)) {
      const found = binding(file, node.text);
      return found?.zodRoot || found?.zodSchema ? found : null;
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const receiver = zodValue(file, node.expression.expression);
    const methods = receiver?.zodRoot ? zodConstructors : receiver?.zodSchema ? zodMethods : null;
    if (!methods?.has(node.expression.name.text) || node.questionDotToken || node.expression.questionDotToken)
      return null;
    for (const argument of node.arguments) zodArgument(file, argument);
    return { zodSchema: true };
  };
  const argumentActive = new Set();
  const argumentBinding = (file, name, exported = false) => {
    const id = `${file}:${exported ? 'export:' : ''}${name}`;
    if (argumentActive.has(id)) fail(file, `zod 인자의 순환 참조 ${name}`);
    argumentActive.add(id);
    try {
      const found = moduleAt(file)[exported ? 'exports' : 'bindings'].get(name);
      if (!found) fail(file, `zod 인자 선언 ${name}을 찾지 못했다`);
      if (found.specifier) return argumentBinding(importFile(file, found.specifier), found.name, true);
      if (found.file) return argumentBinding(found.file, found.name, found.exported);
      if (!found.constant || !found.node) fail(file, `zod 인자 ${name}은 초기값이 있는 const여야 한다`);
      zodArgument(file, found.node);
    } finally {
      argumentActive.delete(id);
    }
  };
  // zod는 생성 중 인자를 형 변환할 수 있다. 별칭 안의 함수 값도 이 경계에서는 허용하지 않는다.
  const zodArgument = (file, node) => {
    if (ts.isIdentifier(node)) return argumentBinding(file, node.text);
    if (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    )
      return;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return zodArgument(file, node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        zodArgument(file, ts.isSpreadElement(element) ? element.expression : element);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!property.name || ts.isComputedPropertyName(property.name))
          fail(file, 'zod 인자의 spread·계산 속성은 읽을 수 없다');
        if (ts.isPropertyAssignment(property)) zodArgument(file, property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) argumentBinding(file, property.name.text);
        else fail(file, 'zod 인자의 메서드·접근자는 읽을 수 없다');
      }
      return;
    }
    if (ts.isCallExpression(node) && zodValue(file, node)) return;
    fail(file, `지원하지 않는 zod 인자 ${ts.SyntaxKind[node.kind]}`);
  };
  // const 선언도 초기값을 실행한다. 참조하지 않은 선언까지 제한된 순수 구문인지 확인한다.
  // 함수 본문은 모듈 초기화 때 실행되지 않으므로 검사하지 않는다.
  const pureInitializer = (file, node) => {
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    )
      return;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return pureInitializer(file, node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        pureInitializer(file, ts.isSpreadElement(element) ? element.expression : element);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!property.name || ts.isComputedPropertyName(property.name))
          fail(file, '초기값의 spread·계산 속성은 읽을 수 없다');
        if (ts.isPropertyAssignment(property)) pureInitializer(file, property.initializer);
        else if (!ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property))
          fail(file, '초기값의 접근자 속성은 읽을 수 없다');
      }
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = binding(file, node.expression.text);
      if (callee.factory && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]))
        return pureInitializer(file, node.arguments[0]);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && zodValue(file, node)) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Set' &&
      !moduleAt(file).bindings.has('Set') &&
      node.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(node.arguments[0]) &&
      node.arguments[0].elements.every((element) => ts.isStringLiteral(element))
    )
      return;
    fail(file, `지원하지 않는 모듈 초기값 ${ts.SyntaxKind[node.kind]}`);
  };
  const object = (file, node, defaultTarget) => {
    const fields = new Map();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name))
        fail(file, '명령 정의의 spread·계산 속성은 읽을 수 없다');
      const name = property.name.text;
      if (name !== 'key' && name !== 'target') continue;
      if (fields.has(name)) fail(file, `${name} 속성이 두 번 있다`);
      if (ts.isPropertyAssignment(property)) fields.set(name, value(file, property.initializer));
      else if (ts.isShorthandPropertyAssignment(property)) fields.set(name, binding(file, name));
      else fail(file, `${name}은 값 속성이어야 한다`);
    }
    const key = fields.get('key');
    const target = fields.has('target') ? fields.get('target') : defaultTarget;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key)) fail(file, 'key는 명령 ID 문자열이어야 한다');
    if (!TARGETS.includes(target)) fail(file, `${key}의 target은 general 또는 nation이어야 한다`);
    return { key, target };
  };
  const value = (file, node) => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      return value(file, node.expression);
    if (ts.isIdentifier(node)) return binding(file, node.text);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isObjectLiteralExpression(node)) return object(file, node);
    if (ts.isArrayLiteralExpression(node)) {
      const list = [];
      for (const element of node.elements) {
        const item = value(file, ts.isSpreadElement(element) ? element.expression : element);
        if (ts.isSpreadElement(element)) {
          if (!Array.isArray(item)) fail(file, '배열 spread 대상은 배열이어야 한다');
          list.push(...item);
        } else list.push(item);
      }
      return list;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = binding(file, node.expression.text);
      if (callee.factory && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]))
        return object(file, node.arguments[0], 'general');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const schema = zodValue(file, node);
      if (schema) return schema;
    }
    fail(file, `지원하지 않는 등록 표현식 ${ts.SyntaxKind[node.kind]}`);
  };
  const commands = binding(entry, 'extensionCommands', true);
  if (!Array.isArray(commands)) fail(entry, 'extensionCommands는 배열이어야 한다');
  const seen = new Set();
  for (const command of commands) {
    if (!command || typeof command.key !== 'string' || !TARGETS.includes(command.target))
      fail(entry, '목록 항목은 명령 정의여야 한다');
    if (seen.has(command.key)) fail(entry, `명령 ${command.key}이 두 번 있다`);
    seen.add(command.key);
  }
  return commands;
}

export function loadContext(root) {
  const read = (path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n') : '';
  const plans = existsSync(join(root, 'docs/plans')) ? readdirSync(join(root, 'docs/plans')) : [];
  let baseline;
  try {
    baseline = JSON.parse(read(BASELINE_PATH));
  } catch {
    baseline = null;
  }
  return {
    root,
    registry: readRegistryKeys(root),
    extensionRegistry: readExtensionRegistryKeys(root),
    baseline,
    readme: read('README.md'),
    prd: read('docs/product/prd.md'),
    acceptance: read('docs/product/acceptance-criteria.md'),
    phases: read('docs/product/phases.md'),
    decisions: read('docs/product/decisions.md'),
    phase2: read('docs/plans/phase2-expansion.md'),
    index: read('docs/index.md'),
    planFiles: new Set(plans),
    fileExists: (path) => existsSync(join(root, path)),
    readDoc: read,
  };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTextArray = (value) => Array.isArray(value) && value.every(isText);

function referenceExists(id, context) {
  if (/^D-\d{3}$/.test(id)) return context.decisions.includes(`## ${id}.`);
  if (/^T\d-\d{2}$/.test(id))
    return (
      context.planFiles.has(`${id}.md`) || context.phases.includes(`| ${id} `) || context.phase2.includes(`| ${id} `)
    );
  if (/^[UAG]-\d{2}$/.test(id)) return context.phase2.includes(`| ${id} `);
  if (/^AC-M\d-\d{2}$/.test(id)) return context.acceptance.includes(`| ${id} `);
  if (/^AC-P2-\d{2}$/.test(id)) return context.phase2.includes(`| ${id} `);
  return false;
}

/** GitHub 방식 제목 앵커. 문장부호를 빼고 공백을 -로 바꾼다. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** 문서에서 앵커 제목부터 같은 수준 이상의 다음 제목 전까지를 돌려준다. 없으면 null. */
export function findSection(text, anchor) {
  const lines = text.split(/\r?\n/);
  const seen = new Map();
  let fence = false;
  let start = -1;
  let level = 0;
  for (const [i, line] of lines.entries()) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) continue;
    if (start >= 0 && heading[1].length <= level) return lines.slice(start, i).join('\n');
    if (start >= 0) continue;
    const base = slugify(heading[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if ((count === 0 ? base : `${base}-${count}`) === anchor) {
      start = i;
      level = heading[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

/** 리뷰 절의 첫 `결과:` 줄이 통과이고 수정 요청·실패가 아니면 true. */
export function reviewPassed(section) {
  const verdict = /결과:\s*([^\n]*)/.exec(section);
  return Boolean(verdict && verdict[1].includes('통과') && !/수정 필요|반려|실패|되돌/.test(verdict[1]));
}

function tableCells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function queueStatus(id, context) {
  for (const text of [context.phases, context.phase2]) {
    const line = text.split('\n').find((l) => l.startsWith(`| ${id} `));
    if (line) return tableCells(line).at(-1) ?? '';
  }
  return null;
}

// ---------------------------------------------------------------- 고정 기준(baseline)

function checkBaseline(baseline, context, errors) {
  const records = new Map();
  const reference = new Map();
  const approved = new Map();
  if (!isObject(baseline)) {
    errors.push(`${BASELINE_PATH}를 읽지 못했다. 원본 ID 전집·승인 관계·검증 기록 없이 대응표를 승인하지 않는다`);
    return { records, reference, approved, commit: null };
  }
  const rev = baseline.referenceRevision;
  const commit = isObject(rev) && FULL_SHA.test(String(rev.commit ?? '')) ? rev.commit : null;
  if (!commit) errors.push('baseline.referenceRevision.commit은 40자리 커밋이어야 한다');
  for (const target of TARGETS) {
    const ids = isObject(rev) && isObject(rev[target]) ? rev[target].ids : null;
    if (!isTextArray(ids)) {
      errors.push(`baseline.referenceRevision.${target}.ids는 문자열 배열이어야 한다`);
      continue;
    }
    for (const key of ids) {
      const id = `${target}:${key}`;
      if (reference.has(id)) errors.push(`baseline 원본 ID ${id}가 두 번 있다`);
      reference.set(id, target);
    }
  }
  if (reference.size === 0) errors.push('baseline 원본 ID 전집이 비어 있다');
  for (const [i, change] of (Array.isArray(baseline.approvedChanges) ? baseline.approvedChanges : []).entries()) {
    const at = `baseline.approvedChanges[${i}]`;
    if (
      !isObject(change) ||
      !['addition', 'replacement'].includes(change.kind) ||
      !isText(change.command) ||
      !TARGETS.includes(change.target) ||
      !isTextArray(change.sourceIds) ||
      !isTextArray(change.approvalRefs)
    ) {
      errors.push(`${at}: {kind(addition|replacement), command, target, sourceIds[], approvalRefs[]} 형식이 아니다`);
      continue;
    }
    if (change.kind === 'addition' && change.sourceIds.length !== 0) errors.push(`${at}: 추가는 원본이 없어야 한다`);
    if (change.kind === 'replacement' && change.sourceIds.length === 0) errors.push(`${at}: 대체는 원본이 있어야 한다`);
    for (const id of change.sourceIds)
      if (reference.get(id) !== change.target)
        errors.push(`${at}: 원본 ${id}가 고정 원본 ID 전집의 ${change.target}에 없다`);
    const decisions = change.approvalRefs.filter((ref) => /^D-\d{3}$/.test(ref));
    if (decisions.length === 0) errors.push(`${at}: 승인 결정(D-xxx)이 없다`);
    for (const ref of change.approvalRefs)
      if (!referenceExists(ref, context)) errors.push(`${at}: 승인 근거 ${ref}가 문서에 없다`);
    if (approved.has(change.command)) errors.push(`${at}: 명령 ${change.command}의 승인 관계가 두 번 있다`);
    approved.set(change.command, change);
  }
  for (const [i, record] of (Array.isArray(baseline.verificationRecords)
    ? baseline.verificationRecords
    : []
  ).entries()) {
    const at = `baseline.verificationRecords[${i}]`;
    if (
      !isObject(record) ||
      !isText(record.id) ||
      !isText(record.review) ||
      !FULL_SHA.test(String(record.sha ?? '')) ||
      !Array.isArray(record.runs) ||
      record.runs.length === 0 ||
      !isTextArray(record.stages) ||
      !isTextArray(record.commands)
    ) {
      errors.push(`${at}: {id, review, sha(40자리), runs[], stages[], commands[]} 형식이 아니다`);
      continue;
    }
    const where = `검증 기록 ${record.id}`;
    for (const stage of record.stages) if (!STAGES.includes(stage)) errors.push(`${where}: 모르는 단계 ${stage}`);
    for (const run of record.runs) {
      if (!isObject(run) || !/^\d+$/.test(String(run.id ?? ''))) {
        errors.push(`${where}: 실행은 {id, headSha, conclusion} 형식이어야 한다`);
        continue;
      }
      if (run.headSha !== record.sha)
        errors.push(`${where}: 실행 ${run.id}의 headSha ${run.headSha}가 기록 SHA ${record.sha}와 다르다`);
      if (run.conclusion !== 'success')
        errors.push(`${where}: 실행 ${run.id}의 결과가 success가 아니다 (${run.conclusion})`);
    }
    const [path, anchor] = record.review.split('#');
    const text = context.readDoc(path);
    const section = anchor ? findSection(text, anchor) : null;
    if (!anchor) errors.push(`${where}: 리뷰 근거는 문서#리뷰절 앵커여야 한다`);
    else if (section === null) errors.push(`${where}: ${record.review} 리뷰 절이 없다`);
    else {
      if (!section.includes(record.sha)) errors.push(`${where}: 리뷰 절이 전체 SHA ${record.sha}를 적지 않았다`);
      for (const run of record.runs)
        if (isObject(run) && !section.includes(`actions/runs/${run.id}`))
          errors.push(`${where}: 리뷰 절이 실행 ${run.id}를 적지 않았다`);
      if (!reviewPassed(section)) errors.push(`${where}: 리뷰 절의 결과가 통과가 아니다`);
    }
    const task = /([T]\d-\d{2})\.md$/.exec(path)?.[1];
    if (task && queueStatus(task, context) !== '완료')
      errors.push(`${where}: 리뷰한 작업 ${task}가 대기열에서 완료가 아니다`);
    records.set(`${record.review}@${record.sha}`, record);
  }
  return { records, reference, approved, commit };
}

// ---------------------------------------------------------------- 단계·증거

function checkEvidence(where, evidence, context, errors) {
  if (!Array.isArray(evidence)) {
    errors.push(`${where}: evidence는 배열이어야 한다`);
    return;
  }
  for (const [i, item] of evidence.entries()) {
    const at = `${where}.evidence[${i}]`;
    if (!isObject(item) || !EVIDENCE_KINDS.includes(item.kind) || !isText(item.ref)) {
      errors.push(`${at}: {kind(${EVIDENCE_KINDS.join('|')}), ref} 형식이 아니다`);
      continue;
    }
    if (item.sha !== undefined && !(typeof item.sha === 'string' && SHA.test(item.sha)))
      errors.push(`${at}: sha는 7~40자리 16진수여야 한다`);
    if (item.kind === 'ci' && !RUN.test(item.ref)) errors.push(`${at}: ci 증거는 actions/runs/<번호> 주소여야 한다`);
    if ((item.kind === 'test' || item.kind === 'doc' || item.kind === 'review') && !/^https?:/.test(item.ref)) {
      const path = item.ref.split('#')[0];
      if (!context.fileExists(path)) errors.push(`${at}: 증거 파일 ${path}가 없다`);
    }
  }
}

function checkVerified(where, commandId, stageName, evidence, records, errors) {
  const withSha = evidence.filter((item) => item.sha !== undefined);
  if (withSha.length === 0) {
    errors.push(`${where}: verified에는 검증한 정확한 전체 SHA가 있어야 한다`);
    return;
  }
  for (const item of withSha)
    if (!FULL_SHA.test(String(item.sha)))
      errors.push(`${where}: verified 근거의 sha ${item.sha}는 40자리 전체 SHA여야 한다`);
  const shas = new Set(withSha.map((item) => item.sha));
  if (shas.size > 1) errors.push(`${where}: verified 근거의 SHA가 서로 다르다 (${[...shas].join(', ')})`);
  const reviews = evidence.filter((item) => item.kind === 'review');
  const runs = evidence.filter((item) => item.kind === 'ci');
  if (reviews.length === 0 || runs.length === 0) {
    errors.push(
      `${where}: verified는 독립 리뷰 기록(review)과 같은 SHA의 실행(ci)이 함께 있어야 한다. 파일 존재만으로는 통과가 아니다`,
    );
    return;
  }
  const matched = reviews.map((item) => records.get(`${item.ref}@${item.sha}`)).filter(Boolean);
  if (matched.length === 0) {
    errors.push(
      `${where}: 리뷰 근거 ${reviews.map((item) => `${item.ref}@${item.sha ?? '-'}`).join(', ')}가 고정 검증 기록(${BASELINE_PATH} verificationRecords)에 없다`,
    );
    return;
  }
  const record = matched[0];
  for (const item of runs) {
    const id = REPO_RUN.exec(item.ref)?.[1];
    if (!id) errors.push(`${where}: ci 증거 ${item.ref}는 peppone-choi/opensamguk의 실행 주소여야 한다`);
    else if (!record.runs.some((run) => run.id === id))
      errors.push(`${where}: 실행 ${id}는 검증 기록 ${record.id}가 확인한 실행이 아니다`);
    if (item.sha !== record.sha) errors.push(`${where}: 실행 ${id ?? item.ref}의 SHA가 검증 기록 SHA와 다르다`);
  }
  if (!record.stages.includes(stageName))
    errors.push(`${where}: 검증 기록 ${record.id}는 ${stageName} 단계를 다루지 않는다`);
  if (!record.commands.includes(commandId))
    errors.push(`${where}: 검증 기록 ${record.id}는 명령 ${commandId}를 다루지 않는다`);
}

function checkStage(where, commandId, stageName, stage, context, records, errors) {
  if (!isObject(stage) || !STATUSES.includes(stage.status)) {
    errors.push(`${where}: status는 ${STATUSES.join('|')} 중 하나여야 한다`);
    return;
  }
  checkEvidence(where, stage.evidence, context, errors);
  if (stage.reason !== undefined && typeof stage.reason !== 'string')
    errors.push(`${where}: reason은 문자열이어야 한다`);
  const evidence = Array.isArray(stage.evidence) ? stage.evidence.filter(isObject) : [];
  if (stage.status === 'not_applicable' && !isText(stage.reason))
    errors.push(`${where}: not_applicable에는 이유가 있어야 한다`);
  if (stage.status === 'partial' && evidence.length === 0)
    errors.push(`${where}: partial에는 증거가 하나 이상 있어야 한다`);
  if (stage.status === 'verified') checkVerified(where, commandId, stageName, evidence, records, errors);
}

function checkTokens(where, texts, context, errors) {
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(REF_TOKEN)) {
      const id = `${match[1]}-${match[2]}`;
      if (!referenceExists(id, context)) errors.push(`${where}: ${id}가 Phase 2 명세에 없다`);
    }
    for (const match of text.matchAll(DECISION_TOKEN)) {
      const id = `D-${match[1]}`;
      if (!referenceExists(id, context)) errors.push(`${where}: ${id}가 결정 기록에 없다`);
    }
  }
}

// ---------------------------------------------------------------- 정본 문서 대조

function markOf(cell) {
  return MARKS.find((mark) => cell.includes(mark)) ?? null;
}

/** 인수조건 문서의 AC 행 상태를 관문별로 다시 센다. */
export function countAcceptance(text) {
  const rows = new Map();
  const counts = Object.fromEntries(GATES.map((gate) => [gate, { total: 0, '✅': 0, '🟨': 0, '⬜': 0 }]));
  for (const line of text.split('\n')) {
    const id = /^\|\s*(AC-(M\d)-\d{2})\s*\|/.exec(line);
    if (!id || !counts[id[2]]) continue;
    const cells = tableCells(line);
    const mark = markOf(cells[3] ?? '');
    rows.set(id[1], { cells, mark });
    counts[id[2]].total += 1;
    if (mark) counts[id[2]][mark] += 1;
  }
  return { rows, counts };
}

function sectionBetween(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

function expectNumbers(errors, where, match, expected, what) {
  if (!match) {
    errors.push(`${where}: ${what} 문장이 없다`);
    return;
  }
  const actual = match.slice(1).map(Number);
  if (actual.some((value, i) => value !== expected[i]))
    errors.push(`${where}: ${what} 불일치 (문서 ${actual.join('/')}, 원장 ${expected.join('/')})`);
}

/** README·PRD·단계 계획·인수조건·Phase 2 명세를 원장 집계와 대조한다. */
export function checkDocuments(summary, commands, complete, context, commit, errors) {
  const { rows, counts } = countAcceptance(context.acceptance);
  const legacy = summary.legacySubset;
  const ref = summary.reference;
  const short = commit ? commit.slice(0, 7) : null;
  const gatePassed = (gate) => counts[gate].total > 0 && counts[gate]['✅'] === counts[gate].total;

  // 인수조건: 요약표 집계, AC-M1-14 상태·조건·증거
  const summaryTable = sectionBetween(context.acceptance, '## 요약');
  for (const gate of GATES) {
    const line = summaryTable.split('\n').find((l) => l.startsWith(`| ${gate} `));
    const cells = line ? tableCells(line) : [];
    const declared = cells.slice(1, 5).map(Number);
    const actual = [counts[gate].total, counts[gate]['✅'], counts[gate]['🟨'], counts[gate]['⬜']];
    if (!line) errors.push(`인수조건 요약: ${gate} 행이 없다`);
    else if (declared.some((value, i) => value !== actual[i]))
      errors.push(`인수조건 요약: ${gate}가 ${declared.join('/')}인데 AC 행을 다시 세면 ${actual.join('/')}이다`);
  }
  const ac = rows.get('AC-M1-14');
  if (!ac) errors.push('인수조건: AC-M1-14 행이 없다');
  else {
    const [, condition = '', , , evidence = ''] = ac.cells;
    if (!ac.mark) errors.push('인수조건 AC-M1-14: 상태 칸이 ✅·🟨·⬜가 아니다');
    if (ac.mark === '✅' && !complete)
      errors.push(`인수조건 AC-M1-14: 남은 행이 있는데 ✅다 (전 단계 완료 ${summary.complete}/${summary.denominator})`);
    if (!(condition + evidence).includes('command-coverage.json'))
      errors.push('인수조건 AC-M1-14 행이 command-coverage.json을 가리키지 않는다');
    if (!condition.includes('MVP의 모든 명령이 완료된다'))
      errors.push('인수조건 AC-M1-14: 조건이 전체 명령 범위(D-022)가 아니다');
    const reference = /core2026 `([0-9a-f]{7,40})`의 원본 (\d+)개\(장수 (\d+)·국가 (\d+)\)/.exec(condition);
    if (reference && short && !commit.startsWith(reference[1]))
      errors.push(`인수조건 AC-M1-14: 원작 revision ${reference[1]}이 고정 기준 ${short}와 다르다`);
    expectNumbers(
      errors,
      '인수조건 AC-M1-14 조건',
      reference && [reference[0], ...reference.slice(2)],
      [ref.total, ref.general, ref.nation],
      '원작 분모(합/장수/국가)',
    );
    const legacyLeft = condition.replace(/원래 조건\([^)]*\)은 부분집합/g, '');
    if (legacyLeft.includes(`MVP 명령 ${legacy.registryKeys}개`))
      errors.push(`인수조건 AC-M1-14: 옛 ${legacy.registryKeys}개 범위가 부분집합 이력 밖에 있다`);
    expectNumbers(
      errors,
      '인수조건 AC-M1-14 증거',
      /정본 분모 (\d+)\(명령 (\d+) \+ 미해결 원본 (\d+)\), 전 단계 완료 (\d+)/.exec(evidence),
      [summary.denominator, summary.commands, summary.unresolvedReferences, summary.complete],
      '정본 분모·명령·미해결·전 단계 완료',
    );
    const overall = /전체 명령: (완료|미완료)/.exec(evidence)?.[1];
    if (!overall) errors.push('인수조건 AC-M1-14 증거: "전체 명령: 완료|미완료" 판정이 없다');
    else if ((overall === '완료') !== complete)
      errors.push(`인수조건 AC-M1-14 증거: 전체 명령 ${overall}인데 원장은 ${complete ? '완료' : '미완료'}다`);
  }

  // README: 관문 집계, 대응표 출력 문장
  for (const gate of GATES) {
    const line = context.readme.split('\n').find((l) => l.startsWith(`| ${gate} `));
    if (!line) {
      errors.push(`README: ${gate} 관문 행이 없다`);
      continue;
    }
    const total = /\[AC-M\d (\d+)개\]/.exec(line);
    if (!total || Number(total[1]) !== counts[gate].total)
      errors.push(`README ${gate}: AC 개수 ${total?.[1] ?? '없음'}가 인수조건 ${counts[gate].total}와 다르다`);
    const cell = tableCells(line).at(-1) ?? '';
    const progress = /진행 중 \(✅ (\d+) · 🟨 (\d+) · ⬜ (\d+)\)/.exec(cell);
    if (progress) {
      const actual = [counts[gate]['✅'], counts[gate]['🟨'], counts[gate]['⬜']];
      if (progress.slice(1).some((value, i) => Number(value) !== actual[i]))
        errors.push(`README ${gate}: ${progress.slice(1).join('/')}인데 인수조건은 ${actual.join('/')}이다`);
    } else if (!gatePassed(gate)) errors.push(`README ${gate}: AC가 전부 ✅가 아닌데 진행 중 집계가 아니다 (${cell})`);
  }
  expectNumbers(
    errors,
    'README',
    /원작 비교 분모 (\d+)개, 정본 분모 (\d+)개, 전 단계 완료 (\d+)개/.exec(context.readme),
    [ref.total, summary.denominator, summary.complete],
    '명령 대응표 출력(원작/정본/전 단계 완료)',
  );
  if (!context.readme.includes('command-coverage.json')) errors.push('README가 명령 대응표를 가리키지 않는다');

  // PRD: §1.1 원작 개수, §6.3 범위·분모·37개 부분집합 표기
  expectNumbers(
    errors,
    'PRD §1.1',
    /장수 명령 (\d+)개, 국가 명령 (\d+)개/.exec(context.prd),
    [ref.general, ref.nation],
    '원작 장수·국가 명령 수',
  );
  if (!context.prd.includes('command-coverage.json')) errors.push('PRD가 command-coverage.json을 가리키지 않는다');
  if (!context.prd.includes('MVP는 모든 명령을 완료한다')) errors.push('PRD §6.3: 전체 명령 범위(D-022) 문장이 없다');
  const prdDenominator = /비교 분모는 core2026 `([0-9a-f]{7,40})`의 (\d+)개\(장수 (\d+), 국가 (\d+)\)다/.exec(
    context.prd,
  );
  if (prdDenominator && short && !commit.startsWith(prdDenominator[1]))
    errors.push(`PRD §6.3: 원작 revision ${prdDenominator[1]}이 고정 기준 ${short}와 다르다`);
  expectNumbers(
    errors,
    'PRD §6.3',
    prdDenominator && [prdDenominator[0], ...prdDenominator.slice(2)],
    [ref.total, ref.general, ref.nation],
    '비교 분모(합/장수/국가)',
  );
  expectNumbers(
    errors,
    'PRD §6.3',
    /\*\*장수 명령 (\d+)개 \(M1 부분집합\)\*\*/.exec(context.prd),
    [legacy.general],
    '장수 명령 M1 부분집합 표기',
  );
  expectNumbers(
    errors,
    'PRD §6.3',
    /\*\*국가 명령 (\d+)개 \(M1 부분집합\):\*\*/.exec(context.prd),
    [legacy.nation],
    '국가 명령 M1 부분집합 표기',
  );
  if (/90개 중 37개다|MVP는 37개/.test(context.prd)) errors.push('PRD: MVP를 옛 37개 범위로 적었다');

  // 단계 계획: D-022 안내의 AC-M1-14 상태, M1 거짓 통과, T1-08 부분집합 표기
  const phaseLine =
    /AC-M1-14는 전체 명령 수용 관문으로 바뀌어 (✅|🟨|⬜)로 돌아갔고 M1도 이 행이 ✅가 될 때까지 통과하지 않는다/.exec(
      context.phases,
    );
  if (!phaseLine) errors.push('단계 계획: AC-M1-14 전체 명령 관문과 M1 미통과 안내(D-022)가 없다');
  else if (ac?.mark && phaseLine[1] !== ac.mark)
    errors.push(`단계 계획: AC-M1-14를 ${phaseLine[1]}로 적었으나 인수조건은 ${ac.mark}다`);
  expectNumbers(
    errors,
    '단계 계획',
    /T1-08 완료는 (\d+)개 부분집합 기준/.exec(context.phases),
    [legacy.registryKeys],
    'T1-08 부분집합 표기',
  );
  if (!/2026-10-22 D-022로 이 명령들은 MVP 필수가 됐다/.test(context.phases))
    errors.push('단계 계획 Phase 2: 명령 확장이 MVP 필수(D-022)라는 표기가 없다');
  for (const [name, text] of [
    ['단계 계획', context.phases],
    ['README', context.readme],
  ]) {
    if (
      !gatePassed('M1') &&
      /M1(?:\s*관문)?(?:은|는|이|가|도)?\s*(?:모두\s*|전부\s*)?통과(?:했|다|함|한다|됐|되었)/.test(text)
    )
      errors.push(`${name}: AC-M1이 전부 ✅가 아닌데 M1 통과라고 적었다`);
    if (!complete && /MVP(?:는|가|를)?\s*완료(?:했|됐|되었|다\.)/.test(text))
      errors.push(`${name}: 남은 명령이 있는데 MVP 완료라고 적었다`);
  }

  // Phase 2 명세(PR67 표): 완료 판정 위치, 명령 작업 T4 행의 MVP 필수 표시, 분해 없음 안내
  if (!/명령의 완료 판정은 AC-M1-14와 \[명령 대응표\]/.test(context.phase2))
    errors.push('Phase 2 명세 §1: 명령 완료 판정이 AC-M1-14와 대응표라는 문장이 없다');
  const t4 = new Set(commands.flatMap((command) => (command.queueIds ?? []).filter((id) => /^T4-\d{2}$/.test(id))));
  for (const id of [...t4].sort()) {
    const status = queueStatus(id, { phases: '', phase2: context.phase2 });
    if (status === null) errors.push(`Phase 2 명세 §6: 대응표가 쓰는 ${id} 행이 없다`);
    else if (!status.includes('MVP 필수 (D-022)')) errors.push(`Phase 2 명세 §6: ${id} 상태에 MVP 필수 (D-022)가 없다`);
  }
  const undecomposed = commands.some((command) => /\bA-0[234]\b/.test((command.blockers ?? []).join(' ')));
  if (undecomposed && !context.phase2.includes('A-02·A-03·A-04의 명령은 MVP 범위에 들어왔으나 작업 분해는 아직 없다'))
    errors.push('Phase 2 명세 §1: A-02·A-03·A-04 명령의 작업 분해 없음 안내가 없다');

  if (!context.index.includes('command-coverage.json'))
    errors.push('docs/index.md 지도에 command-coverage.json이 없다');
  if (!context.index.includes('command-coverage-baseline.json'))
    errors.push('docs/index.md 지도에 command-coverage-baseline.json이 없다');
}

// ---------------------------------------------------------------- 대응표

/** 대응표 정합을 검사하고 남은 일과 집계를 돌려준다. errors가 비어 있으면 정합이다. */
export function analyze(doc, context) {
  const errors = [];
  if (!isObject(doc)) return { errors: ['대응표가 JSON 객체가 아니다'], gaps: [], summary: null };
  const base = checkBaseline(context.baseline, context, errors);
  if (doc.version !== 1) errors.push('version은 1이어야 한다');
  if (!(typeof doc.sourceRevision === 'string' && FULL_SHA.test(doc.sourceRevision)))
    errors.push('sourceRevision은 40자리 커밋이어야 한다');
  if (!isText(doc.ownerDirective)) errors.push('ownerDirective가 비어 있다');
  if (!isObject(doc.referenceRevision) || !FULL_SHA.test(String(doc.referenceRevision.commit ?? '')))
    errors.push('referenceRevision.commit은 40자리 커밋이어야 한다');
  else if (base.commit && doc.referenceRevision.commit !== base.commit)
    errors.push(`referenceRevision.commit ${doc.referenceRevision.commit}이 고정 기준 ${base.commit}와 다르다`);
  const references = Array.isArray(doc.referenceCommands) ? doc.referenceCommands : [];
  const commands = Array.isArray(doc.commands) ? doc.commands : [];
  const unresolved = Array.isArray(doc.unresolvedReferences) ? doc.unresolvedReferences : null;
  if (!Array.isArray(doc.referenceCommands)) errors.push('referenceCommands는 배열이어야 한다');
  if (!Array.isArray(doc.commands)) errors.push('commands는 배열이어야 한다');
  if (unresolved === null) errors.push('unresolvedReferences는 배열이어야 한다 (없으면 빈 배열)');

  const referenceTarget = new Map();
  for (const [i, ref] of references.entries()) {
    if (!isObject(ref) || !isText(ref.id) || !TARGETS.includes(ref.target) || !isText(ref.source)) {
      errors.push(`referenceCommands[${i}]: {id, target(general|nation), source} 형식이 아니다`);
      continue;
    }
    if (referenceTarget.has(ref.id)) errors.push(`원본 ID ${ref.id}가 두 번 있다`);
    referenceTarget.set(ref.id, ref.target);
  }
  // 원본 ID 전집은 검사 대상과 따로 고정한 기준으로 대조한다. 개수만 맞는 ID 치환도 잡는다.
  for (const [id, target] of base.reference)
    if (!referenceTarget.has(id)) errors.push(`고정 원본 ID ${id}가 referenceCommands에 없다`);
    else if (referenceTarget.get(id) !== target) errors.push(`원본 ${id}의 target이 고정 기준 ${target}와 다르다`);
  for (const id of referenceTarget.keys())
    if (base.reference.size && !base.reference.has(id)) errors.push(`원본 ${id}는 고정 원작 revision의 ID가 아니다`);
  const refCount = (target) => references.filter((ref) => ref?.target === target).length;

  const mappedBy = new Map();
  const mark = (id, owner) => {
    if (!referenceTarget.has(id)) errors.push(`${owner}: 원본 목록에 없는 ID ${id}`);
    else if (mappedBy.has(id)) errors.push(`원본 ${id}가 ${mappedBy.get(id)}와 ${owner}에 이중 매핑됐다`);
    else mappedBy.set(id, owner);
  };
  for (const [i, item] of (unresolved ?? []).entries()) {
    if (!isObject(item) || !isText(item.id) || !isText(item.reason) || !isTextArray(item.decisionRefs ?? null)) {
      errors.push(`unresolvedReferences[${i}]: {id, reason, decisionRefs[]} 형식이 아니다`);
      continue;
    }
    mark(item.id, `unresolved[${item.id}]`);
    for (const ref of item.decisionRefs)
      if (!referenceExists(ref, context)) errors.push(`unresolved[${item.id}]: 결정 ${ref}가 문서에 없다`);
  }

  const legacyRegistry = new Map(context.registry.map((entry) => [entry.key, entry.target]));
  const registry = new Map(legacyRegistry);
  for (const { key, target } of context.extensionRegistry ?? []) {
    if (registry.has(key)) errors.push(`확장 registry key ${key}가 기본·확장 목록과 겹친다`);
    else registry.set(key, target);
  }
  const commandIds = new Map();
  const gaps = [];
  const rows = [];
  for (const [i, command] of commands.entries()) {
    const where = `commands[${isObject(command) && isText(command.id) ? command.id : i}]`;
    if (!isObject(command) || !isText(command.id) || !TARGETS.includes(command.target)) {
      errors.push(`${where}: id·target(general|nation)이 없다`);
      continue;
    }
    if (commandIds.has(command.id)) errors.push(`명령 ID ${command.id}가 두 번 있다`);
    commandIds.set(command.id, command.target);
    for (const field of ['sourceIds', 'approvalRefs', 'acIds', 'queueIds', 'paths', 'blockers'])
      if (!isTextArray(command[field])) errors.push(`${where}: ${field}는 문자열 배열이어야 한다`);
    for (const field of ['ownerProfile', 'reviewerProfile'])
      if (!isText(command[field])) errors.push(`${where}: ${field}가 없다`);
    if (command.replacementReason !== null && !isText(command.replacementReason))
      errors.push(`${where}: replacementReason은 null이나 설명이어야 한다`);
    const sources = isTextArray(command.sourceIds) ? command.sourceIds : [];
    const approvals = isTextArray(command.approvalRefs) ? command.approvalRefs : [];
    for (const id of sources) {
      mark(id, where);
      if (referenceTarget.has(id) && referenceTarget.get(id) !== command.target)
        errors.push(`${where}: 원본 ${id}와 target이 다르다`);
    }
    if (sources.length !== 1 && (!isText(command.replacementReason) || approvals.length === 0))
      errors.push(
        `${where}: 원본 ${sources.length}개 대응(추가·이름 통합)은 replacementReason과 승인 근거(approvalRefs)가 있어야 한다`,
      );
    if (isText(command.replacementReason) && approvals.length === 0)
      errors.push(`${where}: 대체 사유에는 승인 근거(approvalRefs)가 있어야 한다`);
    // 승인된 추가·대체는 고정 기준과 맞아야 하고, 기준에 없는 추가·통합·대체는 승인되지 않은 것이다.
    const approved = base.approved.get(command.id);
    if (approved) {
      if (approved.target !== command.target) errors.push(`${where}: 승인된 target ${approved.target}와 다르다`);
      if (JSON.stringify([...sources].sort()) !== JSON.stringify([...approved.sourceIds].sort()))
        errors.push(
          `${where}: 원본 [${sources.join(', ')}]이 승인된 ${approved.kind} 원본 [${approved.sourceIds.join(', ')}]과 다르다`,
        );
      if (!isText(command.replacementReason))
        errors.push(`${where}: 승인된 ${approved.kind}의 replacementReason이 없다`);
      for (const ref of approved.approvalRefs)
        if (!approvals.includes(ref))
          errors.push(`${where}: 승인된 ${approved.kind}의 근거 ${ref}가 approvalRefs에 없다`);
    } else {
      if (sources.length === 0) errors.push(`${where}: 원본 없는 추가 명령이 고정 기준의 승인 목록에 없다`);
      else if (sources.length > 1) errors.push(`${where}: 원본 통합이 고정 기준의 승인 목록에 없다`);
      else if (command.replacementReason !== null)
        errors.push(`${where}: 대체 사유가 있으나 고정 기준의 승인 목록에 없다`);
    }
    for (const ref of approvals)
      if (!referenceExists(ref, context)) errors.push(`${where}: 승인 근거 ${ref}가 문서에 없다`);
    for (const ref of command.acIds ?? [])
      if (!referenceExists(ref, context)) errors.push(`${where}: AC ${ref}가 인수조건·Phase 2 명세에 없다`);
    for (const ref of command.queueIds ?? [])
      if (!referenceExists(ref, context)) errors.push(`${where}: 작업 ${ref}가 대기열·계획에 없다`);
    for (const path of command.paths ?? [])
      if (typeof path === 'string' && !context.fileExists(path)) errors.push(`${where}: 경로 ${path}가 없다`);
    checkTokens(where, [...(command.blockers ?? []), command.replacementReason], context, errors);

    const stages = isObject(command.stages) ? command.stages : {};
    if (!isObject(command.stages)) errors.push(`${where}: stages가 없다`);
    const extra = Object.keys(stages).filter((key) => !STAGES.includes(key));
    if (extra.length) errors.push(`${where}: 모르는 단계 ${extra.join(', ')}`);
    const status = {};
    for (const stage of STAGES) {
      if (!(stage in stages)) {
        errors.push(`${where}.${stage}: 단계가 빠졌다`);
        status[stage] = 'missing';
        continue;
      }
      checkStage(`${where}.${stage}`, command.id, stage, stages[stage], context, base.records, errors);
      status[stage] = stages[stage]?.status;
    }
    const inRegistry = registry.has(command.id);
    if (inRegistry && registry.get(command.id) !== command.target)
      errors.push(`${where}: registry target ${registry.get(command.id)}와 다르다`);
    if (!inRegistry)
      for (const stage of IMPLEMENTATION_STAGES)
        if (status[stage] === 'partial' || status[stage] === 'verified')
          errors.push(`${where}.${stage}: registry에 없는 key인데 구현됐다고 적었다`);

    const open = STAGES.filter((stage) => status[stage] !== 'verified' && status[stage] !== 'not_applicable');
    if (open.length) gaps.push({ id: command.id, open, blockers: command.blockers ?? [] });
    rows.push({ id: command.id, status, sources: sources.length });
  }
  for (const [key, target] of registry)
    if (!commandIds.has(key)) errors.push(`registry key ${key}(${target})가 대응표에 없다`);
  for (const id of referenceTarget.keys())
    if (!mappedBy.has(id)) errors.push(`원본 ${id}의 대응이나 unresolved가 없다`);
  for (const [id, change] of base.approved)
    if (!commandIds.has(id))
      errors.push(`승인된 ${change.kind} ${id}(${change.approvalRefs.join(', ')}) 행이 대응표에 없다`);
  for (const item of unresolved ?? [])
    if (isObject(item) && isText(item.id)) gaps.push({ id: item.id, open: ['unresolved'], blockers: [item.reason] });

  const count = (stage) => rows.filter((row) => row.status[stage] === 'verified').length;
  const stageCounts = Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      Object.fromEntries(STATUSES.map((value) => [value, rows.filter((row) => row.status[stage] === value).length])),
    ]),
  );
  const unresolvedCount = (unresolved ?? []).length;
  const summary = {
    reference: { total: references.length, general: refCount('general'), nation: refCount('nation') },
    legacySubset: {
      registryKeys: legacyRegistry.size,
      general: [...legacyRegistry.values()].filter((target) => target === 'general').length,
      nation: [...legacyRegistry.values()].filter((target) => target === 'nation').length,
      inTable: [...legacyRegistry.keys()].filter((key) => commandIds.has(key)).length,
    },
    denominator: commands.length + unresolvedCount,
    commands: commands.length,
    mappedReferences: mappedBy.size - unresolvedCount,
    unresolvedReferences: unresolvedCount,
    additions: rows.filter((row) => row.sources === 0).length,
    implemented: count('engine'),
    reviewed: count('independentReview'),
    executed: count('exactShaValidation'),
    merged: count('merge'),
    complete: rows.filter((row) =>
      STAGES.every((s) => row.status[s] === 'verified' || row.status[s] === 'not_applicable'),
    ).length,
    stageCounts,
  };
  checkDocuments(summary, commands.filter(isObject), gaps.length === 0, context, base.commit, errors);
  return { errors, gaps, summary };
}

// ---------------------------------------------------------------- 저장소·원격 확인

const git = (root, args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

/** 증거 SHA가 커밋인지, verified 단계의 시험 파일이 검증 SHA에 있었는지, 리뷰 문서가 추적되는지 본다. */
export function verifyGitShas(doc, root, baseline = null) {
  const errors = [];
  const seen = new Set();
  const check = (sha) => {
    if (seen.has(sha)) return;
    seen.add(sha);
    try {
      git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      errors.push(`증거 SHA ${sha}가 저장소에 없다`);
    }
  };
  for (const command of doc.commands ?? [])
    for (const [name, stage] of Object.entries(command.stages ?? {})) {
      for (const item of stage?.evidence ?? []) if (item?.sha) check(item.sha);
      if (stage?.status !== 'verified') continue;
      const sha = (stage.evidence ?? []).find((item) => item?.kind === 'review' && item.sha)?.sha;
      if (!sha) continue;
      for (const item of stage.evidence ?? [])
        if (item?.kind === 'test' && !/^https?:/.test(item.ref)) {
          try {
            git(root, ['cat-file', '-e', `${sha}:${item.ref.split('#')[0]}`]);
          } catch {
            errors.push(`commands[${command.id}].${name}: 시험 ${item.ref}가 검증 SHA ${sha}에 없다`);
          }
        }
    }
  for (const record of baseline?.verificationRecords ?? []) {
    if (record?.sha) check(record.sha);
    const path = String(record?.review ?? '').split('#')[0];
    try {
      git(root, ['ls-files', '--error-unmatch', path]);
    } catch {
      errors.push(`검증 기록 ${record?.id}: 리뷰 문서 ${path}가 저장소에 추적되지 않는다`);
    }
  }
  return errors;
}

function ghRun(id) {
  const out = execFileSync('gh', ['api', `repos/peppone-choi/opensamguk/actions/runs/${id}`], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** 검증 기록의 실행을 GitHub에서 다시 읽어 SHA와 결과를 대조한다. fetchRun은 시험에서 바꿔 끼운다. */
export function verifyCiRuns(baseline, fetchRun = ghRun) {
  const errors = [];
  for (const record of baseline?.verificationRecords ?? [])
    for (const run of record?.runs ?? []) {
      let actual;
      try {
        actual = fetchRun(run.id);
      } catch (error) {
        errors.push(
          `검증 기록 ${record.id}: 실행 ${run.id}를 GitHub에서 읽지 못했다 (${error.message.split('\n')[0]})`,
        );
        continue;
      }
      if (actual?.head_sha !== record.sha)
        errors.push(
          `검증 기록 ${record.id}: 실행 ${run.id}의 실제 head_sha ${actual?.head_sha}가 ${record.sha}와 다르다`,
        );
      if (actual?.conclusion !== 'success')
        errors.push(`검증 기록 ${record.id}: 실행 ${run.id}의 실제 결과가 ${actual?.conclusion}이다`);
    }
  return errors;
}

export function render({ errors, gaps, summary }, { requireComplete = false } = {}) {
  const lines = ['명령 대응표 검사 (AC-M1-14, D-022)'];
  if (summary) {
    const s = summary;
    lines.push(
      `원작 비교 분모: ${s.reference.total}개 (장수 ${s.reference.general}, 국가 ${s.reference.nation})`,
      `현재 정본 분모: ${s.denominator}개 (명령 행 ${s.commands} + 미해결 원본 ${s.unresolvedReferences}), 원본 대응 ${s.mappedReferences}, 추가 ${s.additions}`,
      `M1 37개 부분집합 이력: registry ${s.legacySubset.registryKeys}개 (장수 ${s.legacySubset.general}, 국가 ${s.legacySubset.nation}), 대응표 포함 ${s.legacySubset.inTable}`,
      `구현(engine verified) ${s.implemented} · 리뷰 ${s.reviewed} · exact SHA 실행 ${s.executed} · 병합 ${s.merged} · 전 단계 완료 ${s.complete}/${s.denominator}`,
    );
  }
  lines.push(errors.length ? `대응표 정합: 실패 ${errors.length}건` : '대응표 정합: 통과');
  for (const error of errors) lines.push(`  오류 ${error}`);
  lines.push(
    `제품 전체 완료: ${gaps.length === 0 && errors.length === 0 ? '완료' : `미완료 (남은 행 ${gaps.length})`}`,
  );
  const shown = requireComplete ? gaps : gaps.slice(0, 15);
  for (const gap of shown)
    lines.push(`  남음 ${gap.id}: ${gap.open.join(', ')}${gap.blockers.length ? ` | ${gap.blockers.join('; ')}` : ''}`);
  if (shown.length < gaps.length)
    lines.push(`  그 밖에 ${gaps.length - shown.length}행 (--require-complete로 전부 출력)`);
  return lines.join('\n');
}

export function main(argv, { root: defaultRoot, fetchRun } = {}) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const root = take('--root') ?? defaultRoot;
  const file = take('--file') ?? join(root, 'docs/product/command-coverage.json');
  const flags = new Set(args);
  for (const flag of flags)
    if (!['--require-complete', '--json', '--verify-git', '--verify-ci'].includes(flag))
      return { code: 2, output: `모르는 옵션 ${flag}` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { code: 2, output: `대응표를 읽지 못했다: ${error.message}` };
  }
  let context;
  try {
    context = loadContext(root);
  } catch (error) {
    return { code: 1, output: `registry를 읽지 못했다: ${error.message}` };
  }
  const result = analyze(doc, context);
  if (flags.has('--verify-git')) result.errors.push(...verifyGitShas(doc, root, context.baseline));
  if (flags.has('--verify-ci')) result.errors.push(...verifyCiRuns(context.baseline, fetchRun));
  const requireComplete = flags.has('--require-complete');
  const output = flags.has('--json') ? JSON.stringify(result, null, 2) : render(result, { requireComplete });
  return { code: exitCode(result, requireComplete), output };
}

/** 정합 오류는 항상 실패다. 남은 일은 --require-complete일 때만 실패다. */
export function exitCode({ errors, gaps }, requireComplete) {
  return errors.length > 0 || (requireComplete && gaps.length > 0) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, output } = main(process.argv.slice(2), { root: fileURLToPath(new URL('..', import.meta.url)) });
  console.log(output);
  process.exitCode = code;
}
