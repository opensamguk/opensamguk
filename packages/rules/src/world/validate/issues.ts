import type { z } from 'zod';

export type ResourceKind = 'MAP' | 'SCENARIO' | 'UNIT_SET' | 'STAT_RULES' | 'PORTRAIT_MAP';
export type Path = (string | number)[];
export type IssueTarget =
  | { kind: 'root' }
  | { kind: 'path'; path: ReadonlyArray<string | number> }
  | { kind: 'city'; index: number }
  | { kind: 'terrain'; layer: 'coast' | 'lakes' | 'mountains' | 'rivers'; index: number }
  | { kind: 'nation' | 'general' | 'diplomacy' | 'crewType'; index: number };

const messages = {
  'resource-too-large': '자원 크기가 검사 한도를 넘습니다.',
  'shape-invalid': '자원 형식이 맞지 않습니다.',
  'map-version-unknown': '지원하지 않는 지도 형식 판입니다.',
  'map-canvas-unsupported': '캔버스 크기가 검사 한도를 넘습니다.',
  'city-id-duplicate': '도시 ID가 겹칩니다.',
  'city-name-duplicate': '도시 이름이 겹칩니다.',
  'city-name-blank': '도시 이름에 불필요한 공백이 있습니다.',
  'city-out-of-canvas': '도시 좌표가 캔버스 밖입니다.',
  'city-level-range': '도시 규모가 권장 범위를 벗어납니다.',
  'city-region-range': '도시 지역이 권장 범위를 벗어납니다.',
  'city-initial-over-max': '도시 초기값이 최대치를 넘습니다.',
  'link-duplicate': '도시 연결이 겹칩니다.',
  'link-self': '도시가 자기 자신과 이어져 있습니다.',
  'link-missing-city': '연결 대상 도시가 없습니다.',
  'link-one-way': '도시 연결이 한쪽에만 있습니다.',
  'network-split': '도시 연결망이 나뉘어 있습니다.',
  'terrain-open': '지형의 점 수나 닫힘이 맞지 않습니다.',
  'terrain-out-of-canvas': '지형 좌표가 캔버스 밖입니다.',
  'scenario-nation-city-missing': '국가의 도시가 지도에 없습니다.',
  'scenario-general-city-missing': '장수의 도시가 지도에 없습니다.',
  'scenario-nation-name-duplicate': '국가 이름이 겹칩니다.',
  'scenario-city-owner-duplicate': '도시 소유가 겹칩니다.',
  'scenario-general-nation-missing': '장수의 소속 국가가 없습니다.',
  'scenario-general-years': '장수의 생년이 몰년보다 늦습니다.',
  'scenario-general-name-duplicate': '장수 이름이 겹칩니다.',
  'scenario-diplomacy-invalid': '외교 국가 쌍이 맞지 않습니다.',
  'scenario-diplomacy-duplicate': '외교 국가 쌍이 겹쳐 마지막 항목을 씁니다.',
  'unitset-crew-id-duplicate': '병종 ID가 겹칩니다.',
  'unitset-default-missing': '기본 병종이 없습니다.',
  'unitset-wall-missing': '성벽 병종이 없습니다.',
  'unitset-default-not-recruitable': '기본 병종을 모병할 수 없습니다.',
  'unitset-arm-unknown': '병종의 계통 이름이 없습니다.',
  'unitset-coef-arm-unknown': '병종 계수의 계통 이름이 없습니다.',
  'stat-rules-inconsistent': '능력치 합계와 범위가 맞지 않습니다.',
} as const;
export type ResourceIssueCode = keyof typeof messages;
export interface ResourceIssue {
  code: ResourceIssueCode;
  severity: 'error' | 'warning';
  message: string;
  target: IssueTarget;
  params: Readonly<Record<string, string | number>>;
  source?: { kind: ResourceKind; index: number };
}
export type CheckGroup =
  | 'limits'
  | 'shape'
  | 'cities'
  | 'links'
  | 'network'
  | 'terrain'
  | 'scenario-refs'
  | 'nations'
  | 'generals'
  | 'diplomacy'
  | 'map-refs'
  | 'crew-types'
  | 'stat'
  | 'portraits';
export interface SkippedCheck {
  group: CheckGroup;
  reason: 'blocked' | 'context-missing' | 'context-invalid';
  contextIndex?: number;
}
export interface ResourceReport<T> {
  kind: ResourceKind;
  status: 'pass' | 'fail' | 'incomplete';
  issues: ResourceIssue[];
  ran: CheckGroup[];
  skipped: SkippedCheck[];
  truncated: boolean;
  value: T | null;
}

export const MAX_DIAGNOSTICS = 1000;
export const codeUnitCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function comparePaths(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i]!;
    const right = b[i]!;
    const order =
      typeof left === 'number'
        ? typeof right === 'number'
          ? left - right
          : -1
        : typeof right === 'number'
          ? 1
          : codeUnitCompare(left, right);
    if (order) return order;
  }
  return a.length - b.length;
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function issue(
  code: ResourceIssueCode,
  target: IssueTarget,
  params: Record<string, string | number> = {},
  severity: ResourceIssue['severity'] = 'error',
): ResourceIssue {
  return { code, target, params, severity, message: messages[code] };
}
export class ReportBuilder<T> {
  readonly issues: ResourceIssue[] = [];
  readonly ran: CheckGroup[] = [];
  readonly skipped: SkippedCheck[] = [];
  private count = 0;
  private hasError = false;
  constructor(readonly kind: ResourceKind) {}
  add(item: ResourceIssue) {
    this.count++;
    this.hasError ||= item.severity === 'error';
    if (this.issues.length < MAX_DIAGNOSTICS) this.issues.push(item);
  }
  did(group: CheckGroup) {
    if (!this.ran.includes(group)) this.ran.push(group);
  }
  skip(group: CheckGroup, reason: SkippedCheck['reason'], contextIndex?: number) {
    this.skipped.push({ group, reason, ...(contextIndex === undefined ? {} : { contextIndex }) });
  }
  finish(value: T | null): ResourceReport<T> {
    return {
      kind: this.kind,
      status: this.hasError ? 'fail' : this.skipped.length ? 'incomplete' : 'pass',
      issues: this.issues,
      ran: this.ran,
      skipped: this.skipped,
      truncated: this.count > MAX_DIAGNOSTICS,
      value,
    };
  }
}
export function addShapeIssues<T>(builder: ReportBuilder<T>, errors: readonly z.core.$ZodIssue[], stat = false) {
  const ordered = errors.map((error) => ({
    error,
    path: error.path.map((p) => (typeof p === 'number' ? p : String(p))),
  }));
  ordered.sort((a, b) => comparePaths(a.path, b.path) || codeUnitCompare(a.error.code, b.error.code));
  for (const { error, path } of ordered) {
    builder.add(
      stat && error.code === 'custom'
        ? issue('stat-rules-inconsistent', { kind: 'root' })
        : issue('shape-invalid', { kind: 'path', path }, { zodCode: error.code }),
    );
  }
}
