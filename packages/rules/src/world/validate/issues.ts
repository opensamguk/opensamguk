import type { z } from 'zod';

export type ResourceKind = 'MAP' | 'SCENARIO' | 'UNIT_SET' | 'STAT_RULES' | 'PORTRAIT_MAP';
export type Severity = 'error' | 'warning';
export type IssueTarget =
  | { kind: 'root' }
  | { kind: 'path'; path: Array<string | number> }
  | { kind: 'city'; index: number }
  | { kind: 'terrain'; layer: 'coast' | 'lakes' | 'mountains' | 'rivers'; index: number }
  | { kind: 'nation'; index: number }
  | { kind: 'general'; index: number }
  | { kind: 'diplomacy'; index: number }
  | { kind: 'crewType'; index: number }
  | { kind: 'armType'; key: string }
  | { kind: 'portrait'; name: string };

// 코드마다 문구에 넣는 params 키를 이 표에 고정한다.
export const RESOURCE_ISSUES = {
  'shape-invalid': ['형식이 맞지 않습니다', ['detail']],
  'resource-id-mismatch': ['자원 ID가 카탈로그 이름과 다릅니다', ['id', 'expectedId']],
  'map-canvas-range': ['캔버스는 700×500이어야 합니다', ['width', 'height']],
  'map-too-large': ['도시 수가 한도를 넘습니다', ['count', 'limit']],
  'city-id-duplicate': ['도시 ID가 겹칩니다', ['id', 'firstIndex']],
  'city-name-empty': ['도시 이름이 공백뿐입니다', ['id']],
  'city-name-duplicate': ['도시 이름이 겹칩니다', ['name', 'firstIndex']],
  'city-out-of-canvas': ['도시 좌표가 캔버스 밖입니다', ['name', 'x', 'y']],
  'city-level-range': ['규모가 1~8 밖입니다', ['name', 'level']],
  'city-region-range': ['지역이 1~8 밖입니다', ['name', 'region']],
  'city-initial-over-max': ['도시 초기값이 최대치를 넘습니다', ['name', 'field', 'initial', 'max']],
  'link-duplicate': ['연결이 겹칩니다', ['name', 'cityId']],
  'link-self': ['도시가 자기 자신과 연결됩니다', ['name', 'cityId']],
  'link-missing-city': ['연결 대상 도시가 없습니다', ['name', 'cityId']],
  'link-one-way': ['연결이 한쪽에만 있습니다', ['name', 'cityId']],
  'network-split': ['모든 도시가 하나의 연결망에 이어져야 합니다', ['name', 'id']],
  'terrain-open': ['지형을 이루는 점 수나 끝점이 맞지 않습니다', ['count']],
  'terrain-degenerate': ['지형의 서로 다른 점이 부족합니다', ['count', 'minimum']],
  'terrain-out-of-canvas': ['지형 좌표가 캔버스 밖입니다', ['pointIndex', 'x', 'y']],
  'terrain-too-large': ['지형 점 수가 한도를 넘습니다', ['count', 'limit']],
  'city-off-land': ['도시가 땅 밖이나 호수 안에 있습니다', ['name', 'x', 'y']],
  'scenario-invalid': ['참조 시나리오 형식이 맞지 않습니다', ['key']],
  'scenario-map-missing': ['시나리오의 짝 지도를 찾을 수 없습니다', ['mapKey']],
  'scenario-map-unpublished': ['시나리오의 짝 지도가 아직 게시되지 않았습니다', ['mapKey']],
  'scenario-map-invalid': ['짝 지도 형식이 맞지 않습니다', []],
  'scenario-nation-name-duplicate': ['국가 이름이 겹칩니다', ['name', 'firstIndex']],
  'scenario-nation-city-missing': ['국가 도시가 지도에 없습니다', ['name', 'city']],
  'scenario-city-owner-duplicate': ['도시 소유 국가가 겹칩니다', ['city', 'firstIndex']],
  'scenario-general-name-duplicate': ['장수 이름이 겹칩니다', ['name', 'firstIndex']],
  'scenario-general-nation-missing': ['장수의 소속 국가가 없습니다', ['name', 'nationId']],
  'scenario-general-city-missing': ['장수 위치 도시가 지도에 없습니다', ['name', 'city']],
  'scenario-general-years': ['장수 생년이 몰년보다 늦습니다', ['name', 'birthYear', 'deathYear']],
  'scenario-diplomacy-invalid': ['외교 국가 쌍이 올바르지 않습니다', ['nationA', 'nationB']],
  'scenario-diplomacy-duplicate': ['외교 국가 쌍이 겹쳐 마지막 줄을 씁니다', ['nationA', 'nationB', 'firstIndex']],
  'unitset-arm-key-invalid': ['계열 키는 1 이상 정수여야 합니다', ['key']],
  'unitset-crew-id-duplicate': ['병종 ID가 겹칩니다', ['id', 'firstIndex']],
  'unitset-crew-name-duplicate': ['병종 이름이 겹칩니다', ['name', 'firstIndex']],
  'unitset-crew-arm-missing': ['병종 계열이 없습니다', ['name', 'armType']],
  'unitset-coef-arm-missing': ['계수의 계열이 없습니다', ['name', 'field', 'key']],
  'unitset-default-missing': ['기본 병종이 없습니다', ['id']],
  'unitset-default-not-recruitable': ['기본 병종은 모병할 수 있어야 합니다', ['id']],
  'unitset-wall-missing': ['성벽 병종 1000이 없습니다', []],
  'stat-rules-inconsistent': ['능력치 합계·최소·최대가 맞지 않습니다', ['total', 'min', 'max']],
  'portrait-id-duplicate': ['같은 초상을 쓰는 이름이 있습니다', ['id', 'firstName']],
} as const;

export type ResourceIssueCode = keyof typeof RESOURCE_ISSUES;
export interface ResourceIssue {
  code: ResourceIssueCode;
  severity: Severity;
  message: string;
  target: IssueTarget;
  params: Record<string, string | number>;
  resource?: { kind: ResourceKind; key: string };
}
export interface ValidationReport<T> {
  ok: boolean;
  issues: ResourceIssue[];
  value: T | null;
}

export function resourceIssue(
  code: ResourceIssueCode,
  params: Record<string, string | number>,
  target: IssueTarget = { kind: 'root' },
): ResourceIssue {
  const [message, keys] = RESOURCE_ISSUES[code];
  const values = keys.flatMap((key) => (params[key] === undefined ? [] : [params[key]]));
  return {
    code,
    severity: ['city-off-land', 'scenario-diplomacy-duplicate', 'portrait-id-duplicate'].includes(code)
      ? 'warning'
      : 'error',
    message:
      code === 'scenario-map-missing' && params.mapKey === undefined
        ? '시나리오의 짝 지도를 지정해야 합니다.'
        : `${message}${values.length ? ` (${values.join(', ')})` : ''}.`,
    target,
    params,
  };
}

export function report<T>(value: T | null, issues: ResourceIssue[]): ValidationReport<T> {
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues, value };
}

export function shapeIssues(error: z.ZodError): ResourceIssue[] {
  return error.issues.map((issue) =>
    resourceIssue(
      'shape-invalid',
      { detail: issue.message },
      {
        kind: 'path',
        path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
      },
    ),
  );
}

export function checkId(id: string, expectedId?: string): ResourceIssue[] {
  return expectedId !== undefined && id !== expectedId
    ? [resourceIssue('resource-id-mismatch', { id, expectedId })]
    : [];
}
