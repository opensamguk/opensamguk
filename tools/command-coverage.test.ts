import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commands } from '../packages/rules/src/index';
import { STAGES, analyze, exitCode, loadContext, main, readRegistryKeys } from './command-coverage.mjs';

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
type Stage = { status: string; evidence: unknown[]; reason?: string };
type Doc = {
  referenceCommands: { id: string; target: string }[];
  unresolvedReferences: { id: string }[];
  commands: {
    id: string;
    sourceIds: string[];
    approvalRefs: string[];
    acIds: string[];
    stages: Record<string, Stage>;
  }[];
};
const table = (): Doc => JSON.parse(readFileSync(tablePath, 'utf8')) as Doc;
const row = (doc: Doc, id: string) => doc.commands.find((command) => command.id === id)!;
const errorsOf = (doc: Doc) => analyze(doc, context).errors.join('\n');

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

  it('반례: 원본 삭제는 PRD 분모 불일치와 모르는 원본 대응으로 실패한다', () => {
    const doc = table();
    doc.referenceCommands = doc.referenceCommands.filter((ref) => ref.id !== 'general:che_화계');
    const errors = errorsOf(doc);
    expect(errors).toContain('PRD의 장수 55, 국가 35와 다르다');
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
    expect(errors).toContain('명령 ID rest가 두 번 있다');
  });

  it('반례: 파일만 있는 verified, SHA 없는 verified, registry 없는 구현 주장은 실패한다', () => {
    const doc = table();
    row(doc, 'farm').stages.ui = {
      status: 'verified',
      evidence: [{ kind: 'test', ref: 'packages/rules/src/commands/farm.test.ts' }],
    };
    row(doc, 'fire_attack').stages.engine = {
      status: 'verified',
      evidence: [{ kind: 'ci', ref: 'https://github.com/peppone-choi/opensamguk/actions/runs/1' }],
    };
    const errors = errorsOf(doc);
    expect(errors).toContain('commands[farm].ui: verified에는 검증한 정확한 SHA가 있어야 한다');
    expect(errors).toContain('commands[farm].ui: verified는 실행(ci)이나 리뷰 기록이 있어야 한다');
    expect(errors).toContain('commands[fire_attack].engine: verified에는 검증한 정확한 SHA가 있어야 한다');
    expect(errors).toContain('commands[fire_attack].engine: registry에 없는 key인데 구현됐다고 적었다');
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

  it('반례: 고친 대응표 파일도 CLI 기본 실행이 1로 끝난다', () => {
    const doc = table();
    doc.commands = doc.commands.filter((command) => command.id !== 'attack');
    const file = join(mkdtempSync(join(tmpdir(), 'coverage-')), 'table.json');
    writeFileSync(file, JSON.stringify(doc));
    const result = main(['--file', file], { root });
    expect(result.code).toBe(1);
    expect(result.output).toContain('registry key attack(general)가 대응표에 없다');
  });

  it('전체 완료 게이트는 모든 단계가 증거로 확인되면 0, 하나라도 남으면 1이다', () => {
    const evidence = [
      { kind: 'ci', ref: 'https://github.com/peppone-choi/opensamguk/actions/runs/1', sha: '0123456' },
      { kind: 'review', ref: 'docs/plans/T1-05.md', sha: '0123456' },
    ];
    const stages: Record<string, Stage> = Object.fromEntries(
      STAGES.map((stage: string) => [
        stage,
        stage === 'restart'
          ? { status: 'not_applicable', evidence: [], reason: '시험용 이유' }
          : { status: 'verified', evidence },
      ]),
    );
    const doc = {
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
    const synthetic = {
      ...context,
      registry: [{ key: 'farm', target: 'general' }],
      prd: '장수 명령 1개, 국가 명령 0개 command-coverage.json',
      acceptance: '| AC-M1-14 | command-coverage.json',
      index: 'command-coverage.json',
    };
    const complete = analyze(doc, synthetic);
    expect(complete.errors).toEqual([]);
    expect(complete.gaps).toEqual([]);
    expect(exitCode(complete, true)).toBe(0);
    stages.merge = { status: 'partial', evidence };
    const open = analyze(doc, synthetic);
    expect(open.errors).toEqual([]);
    expect(open.gaps).toHaveLength(1);
    expect(exitCode(open, false)).toBe(0);
    expect(exitCode(open, true)).toBe(1);
  });
});
