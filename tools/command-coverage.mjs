#!/usr/bin/env node
// AC-M1-14 전체 명령 대응표 검사 (D-022).
// 기본 실행은 대응표 정합만 판정하고 남은 일(gap)을 그대로 출력한다.
// --require-complete는 제품 전체 완료 판정이며 남은 일이 하나라도 있으면 실패한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const TARGETS = ['general', 'nation'];
const IMPLEMENTATION_STAGES = ['engine', 'effectsCostsFailures'];
const SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RUN = /actions\/runs\/\d+/;
const REF_TOKEN = /\b([UAG])-(\d{2})\b/g;
const DECISION_TOKEN = /\bD-(\d{3})\b/g;

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

export function loadContext(root) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '');
  const plans = existsSync(join(root, 'docs/plans')) ? readdirSync(join(root, 'docs/plans')) : [];
  return {
    root,
    registry: readRegistryKeys(root),
    prd: read('docs/product/prd.md'),
    acceptance: read('docs/product/acceptance-criteria.md'),
    phases: read('docs/product/phases.md'),
    decisions: read('docs/product/decisions.md'),
    phase2: read('docs/plans/phase2-expansion.md'),
    index: read('docs/index.md'),
    planFiles: new Set(plans),
    fileExists: (path) => existsSync(join(root, path)),
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

function checkStage(where, stage, context, errors) {
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
  if (stage.status === 'verified') {
    if (!evidence.some((item) => typeof item.sha === 'string' && SHA.test(item.sha)))
      errors.push(`${where}: verified에는 검증한 정확한 SHA가 있어야 한다`);
    if (!evidence.some((item) => item.kind === 'ci' || item.kind === 'review'))
      errors.push(`${where}: verified는 실행(ci)이나 리뷰 기록이 있어야 한다. 파일 존재만으로는 통과가 아니다`);
  }
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

/** 대응표 정합을 검사하고 남은 일과 집계를 돌려준다. errors가 비어 있으면 정합이다. */
export function analyze(doc, context) {
  const errors = [];
  if (!isObject(doc)) return { errors: ['대응표가 JSON 객체가 아니다'], gaps: [], summary: null };
  if (doc.version !== 1) errors.push('version은 1이어야 한다');
  if (!(typeof doc.sourceRevision === 'string' && FULL_SHA.test(doc.sourceRevision)))
    errors.push('sourceRevision은 40자리 커밋이어야 한다');
  if (!isText(doc.ownerDirective)) errors.push('ownerDirective가 비어 있다');
  if (!isObject(doc.referenceRevision) || !FULL_SHA.test(String(doc.referenceRevision.commit ?? '')))
    errors.push('referenceRevision.commit은 40자리 커밋이어야 한다');
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
  const prdCounts = /장수 명령 (\d+)개, 국가 명령 (\d+)개/.exec(context.prd);
  const refCount = (target) => references.filter((ref) => ref?.target === target).length;
  if (!prdCounts) errors.push('PRD §1.1에서 원작 장수·국가 명령 수를 찾지 못했다');
  else if (Number(prdCounts[1]) !== refCount('general') || Number(prdCounts[2]) !== refCount('nation'))
    errors.push(
      `원본 목록(장수 ${refCount('general')}, 국가 ${refCount('nation')})이 PRD의 장수 ${prdCounts[1]}, 국가 ${prdCounts[2]}와 다르다`,
    );

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

  const registry = new Map(context.registry.map((entry) => [entry.key, entry.target]));
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
      checkStage(`${where}.${stage}`, stages[stage], context, errors);
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
  for (const item of unresolved ?? [])
    if (isObject(item) && isText(item.id)) gaps.push({ id: item.id, open: ['unresolved'], blockers: [item.reason] });

  if (!/AC-M1-14[^\n]*command-coverage\.json/.test(context.acceptance))
    errors.push('인수조건 AC-M1-14 행이 command-coverage.json을 가리키지 않는다');
  if (!context.prd.includes('command-coverage.json')) errors.push('PRD가 command-coverage.json을 가리키지 않는다');
  if (!context.index.includes('command-coverage.json'))
    errors.push('docs/index.md 지도에 command-coverage.json이 없다');

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
      registryKeys: registry.size,
      general: [...registry.values()].filter((target) => target === 'general').length,
      nation: [...registry.values()].filter((target) => target === 'nation').length,
      inTable: [...registry.keys()].filter((key) => commandIds.has(key)).length,
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
  return { errors, gaps, summary };
}

export function verifyGitShas(doc, root) {
  const errors = [];
  const seen = new Set();
  for (const command of doc.commands ?? [])
    for (const stage of Object.values(command.stages ?? {}))
      for (const item of stage?.evidence ?? []) {
        if (!item?.sha || seen.has(item.sha)) continue;
        seen.add(item.sha);
        try {
          execFileSync('git', ['cat-file', '-e', `${item.sha}^{commit}`], { cwd: root, stdio: 'ignore' });
        } catch {
          errors.push(`증거 SHA ${item.sha}가 저장소에 없다`);
        }
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

export function main(argv, { root: defaultRoot } = {}) {
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
    if (!['--require-complete', '--json', '--verify-git'].includes(flag))
      return { code: 2, output: `모르는 옵션 ${flag}` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { code: 2, output: `대응표를 읽지 못했다: ${error.message}` };
  }
  const result = analyze(doc, loadContext(root));
  if (flags.has('--verify-git')) result.errors.push(...verifyGitShas(doc, root));
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
