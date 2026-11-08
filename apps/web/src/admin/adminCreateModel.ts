import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

export type CreateOptions = inferRouterOutputs<AppRouter>['admin']['world']['creationOptions'];
export type CreateProfile = Extract<CreateOptions['profiles'][number], { available: true }>;
export type CreateInput = inferRouterInputs<AppRouter>['admin']['world']['create'];
export type CreateReply = inferRouterOutputs<AppRouter>['admin']['world']['createStatus'];
export const resourceFields = {
  scenarioKey: 'SCENARIO',
  mapKey: 'MAP',
  unitSetKey: 'UNIT_SET',
  statRulesKey: 'STAT_RULES',
  portraitMapKey: 'PORTRAIT_MAP',
} as const;
export type ResourceField = keyof typeof resourceFields;
export const resourceFieldList = Object.keys(resourceFields) as ResourceField[];
export type VersionItem = { key: string; name: string; version: number; contentHash: string };
export type VersionList = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: VersionItem[] };
export type VersionLists = Record<ResourceField, VersionList>;
export type CreateDraft = {
  profileId: string;
  /** 기본 묶음과 다르게 고른 칸만 담는다. 비어 있으면 프로필 기본 키를 그대로 보낸다. */
  resources: Partial<Record<ResourceField, string>>;
  name: string;
  presetKey: string;
  turnTerm: string;
  endMode: 'year' | 'none';
  endYear: string;
  seedMode: 'auto' | 'custom';
  seed: string;
};
export type CreateReview = Readonly<{
  revision: string;
  profileId: string;
  profileLabel: string;
  presetLabel: string;
  presetDescriptions: readonly string[];
  scenarioTitle: string;
  /** 칸을 바꾼 조합의 연도·수치는 기본 프로필 값이 아니므로 null이다. 서버가 생성 때 확인한다. */
  startYear: number | null;
  counts: Readonly<CreateProfile['counts']> | null;
  changed: readonly ResourceField[];
  seedMode: 'auto' | 'custom';
  input: Readonly<Omit<CreateInput, 'idempotencyKey'>>;
}>;
export type CreateCommand = Readonly<{ review: CreateReview; input: Readonly<CreateInput> }>;
export type CreatePointer = { version: 1; viewerId: string; idempotencyKey: string; requestId?: string };
export const createDraft = (): CreateDraft => ({
  profileId: '',
  resources: {},
  name: '',
  presetKey: '',
  turnTerm: '',
  endMode: 'year',
  endYear: '',
  seedMode: 'auto',
  seed: '',
});
export function initialCreateProfile(options: CreateOptions, preferredId = 'san10-191') {
  return options.profiles.find((profile) => profile.id === preferredId)?.id ?? '';
}
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function storedText(value: string) {
  return (
    value.length > 0 &&
    !value.includes('\u0000') &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return character.length === 2 || code < 0xd800 || code > 0xdfff;
    })
  );
}
export class CreateDraftError extends Error {
  constructor(
    readonly field: 'profileId' | 'name' | 'presetKey' | 'turnTerm' | 'endYear' | 'seed' | ResourceField,
    message: string,
  ) {
    super(message);
  }
}
function integer(value: string, min: number, max: number, field: 'turnTerm' | 'endYear') {
  if (!/^\d+$/.test(value)) throw new CreateDraftError(field, '연도와 턴 간격은 정수로 입력하세요.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new CreateDraftError(field, '연도와 턴 간격의 범위를 확인하세요.');
  return number;
}
// 확장 묶음 잠금은 서버(apps/engine/src/admin/createRequests.ts)의 묶음 검사와 같아야 한다.
// 형식 2인 expanded-191-v3만 시나리오·지도를 잠그고(병종·능력치·초상은 서버가 검사하지 않음),
// 나머지 확장 묶음은 다섯 칸을 모두 잠근다.
const scenarioMapOnly = new Set(['expanded-191-v3']);
export function lockedFields(profile: Pick<CreateProfile, 'featureProfileKey'>): readonly ResourceField[] {
  if (profile.featureProfileKey === undefined) return [];
  return scenarioMapOnly.has(profile.featureProfileKey) ? ['scenarioKey', 'mapKey'] : resourceFieldList;
}
export const resourceChoice = (profile: Pick<CreateProfile, 'selection'>, draft: CreateDraft, field: ResourceField) =>
  draft.resources[field] ?? profile.selection[field];
export function changedFields(profile: CreateProfile, draft: CreateDraft): ResourceField[] {
  const locked = lockedFields(profile);
  return resourceFieldList.filter(
    (field) => !locked.includes(field) && resourceChoice(profile, draft, field) !== profile.selection[field],
  );
}
export const loadingLists = (): VersionLists => ({
  scenarioKey: { status: 'loading' },
  mapKey: { status: 'loading' },
  unitSetKey: { status: 'loading' },
  statRulesKey: { status: 'loading' },
  portraitMapKey: { status: 'loading' },
});
export function versionLabel(item: Pick<VersionItem, 'name' | 'version'>) {
  return item.version === 1 ? item.name : `${item.name}@${item.version}`;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 쪽마다 받은 목록을 키 중복 없이 name, version 순으로 합친다. */
export function mergeVersionPages(pages: readonly (readonly VersionItem[])[]): VersionItem[] {
  const byKey = new Map<string, VersionItem>();
  for (const page of pages) for (const item of page) if (!byKey.has(item.key)) byKey.set(item.key, item);
  return [...byKey.values()].sort((a, b) => compare(a.name, b.name) || a.version - b.version);
}
export function reviewCreation(
  options: CreateOptions,
  draft: CreateDraft,
  viewerId: string,
  autoSeed: string,
  versions?: VersionLists | null,
): CreateReview {
  const profile = options.profiles.find(
    (entry): entry is CreateProfile => entry.available && entry.id === draft.profileId,
  );
  const preset = profile?.presets.find((entry) => entry.key === draft.presetKey);
  const name = draft.name.trim(),
    seed = draft.seedMode === 'auto' ? autoSeed : draft.seed;
  if (!uuid(viewerId) || options.userId !== viewerId) throw new Error('현재 계정과 생성 설정을 확인하세요.');
  if (!profile) throw new CreateDraftError('profileId', '현재 시나리오를 선택하세요.');
  if (!storedText(name)) throw new CreateDraftError('name', '월드 이름을 확인하세요.');
  if (!preset) throw new CreateDraftError('presetKey', '현재 프리셋을 선택하세요.');
  if (!storedText(seed)) throw new CreateDraftError('seed', '시드의 빈칸과 저장할 수 없는 문자를 확인하세요.');
  const changed = changedFields(profile, draft);
  for (const field of changed) {
    const list = versions?.[field];
    if (list?.status !== 'ready' || !list.items.some((item) => item.key === draft.resources[field]))
      throw new CreateDraftError(field, `선택한 판이 게시 목록에 없습니다: ${draft.resources[field]}`);
  }
  const selection = { ...profile.selection };
  for (const field of changed) selection[field] = draft.resources[field]!;
  const input = {
    expectedUserId: viewerId,
    name,
    ...selection,
    ...(profile.featureProfileKey === undefined ? {} : { featureProfileKey: profile.featureProfileKey }),
    presetKey: preset.key,
    turnTermMinutes: integer(draft.turnTerm, 1, 2147483647, 'turnTerm'),
    endYear:
      draft.endMode === 'none'
        ? null
        : integer(draft.endYear, changed.length ? 1 : profile.startYear, 10000, 'endYear'),
    seed,
    // 일반 조합에서 칸을 바꾸면 생략하고 서버가 판에서 기능을 계산한다.
    // 확장 묶음은 서버가 featureProfileKey와 ruleFeatures의 정확한 묶음 일치를 요구하므로 바꿔도 프로필 목록을 유지한다.
    ...(profile.featureProfileKey === undefined && changed.length > 0
      ? {}
      : { ruleFeatures: Object.freeze([...profile.ruleFeatures]) as string[] }),
  };
  return Object.freeze({
    revision: options.revision,
    profileId: profile.id,
    profileLabel: profile.label,
    presetLabel: preset.label,
    presetDescriptions: Object.freeze([...preset.descriptions]),
    scenarioTitle: profile.scenarioTitle,
    startYear: changed.length ? null : profile.startYear,
    counts: changed.length ? null : Object.freeze({ ...profile.counts }),
    changed: Object.freeze(changed),
    seedMode: draft.seedMode,
    input: Object.freeze(input),
  });
}
export function freezeCreation(review: CreateReview, idempotencyKey: string): CreateCommand {
  if (!uuid(idempotencyKey)) throw new Error('요청 번호를 준비하지 못했습니다.');
  // ruleFeatures를 생략한 검토는 생략한 채 보낸다. 빈 배열로 바꾸면 서버 계산과 다른 요청이 된다.
  const input = {
    ...review.input,
    ...(review.input.ruleFeatures === undefined
      ? {}
      : { ruleFeatures: Object.freeze([...review.input.ruleFeatures]) as string[] }),
    idempotencyKey,
  };
  return Object.freeze({ review, input: Object.freeze(input) });
}
/** FAILED 응답은 서버 문구를 우선 보이고, 비어 있을 때만 고정 문구를 쓴다. */
export function failureMessage(error: { code: string; message?: string | null }) {
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return message || createRejections[error.code as keyof typeof createRejections] || createRejections.INPUT_INVALID;
}
export const createRejections = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  RESOURCE_INVALID: '고정한 생성 자원을 확인하지 못했습니다.',
  INPUT_INVALID: '월드 생성 설정을 확인하세요.',
} as const;
export function ownCreateReply(reply: CreateReply, pointer: CreatePointer) {
  return (
    reply.userId === pointer.viewerId &&
    reply.idempotencyKey === pointer.idempotencyKey &&
    uuid(reply.requestId) &&
    (pointer.requestId === undefined || reply.requestId === pointer.requestId) &&
    (reply.status === 'DONE'
      ? uuid(reply.worldId) && reply.error === null
      : reply.status === 'PENDING'
        ? reply.worldId === null && reply.error === null
        : reply.status === 'FAILED' &&
          reply.worldId === null &&
          reply.error !== null &&
          Object.hasOwn(createRejections, reply.error.code))
  );
}
export function createPointer(value: unknown, viewerId: string): CreatePointer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.viewerId !== viewerId ||
    !uuid(viewerId) ||
    !uuid(record.idempotencyKey) ||
    Object.keys(record).some((key) => !['version', 'viewerId', 'idempotencyKey', 'requestId'].includes(key)) ||
    (record.requestId !== undefined && !uuid(record.requestId))
  )
    return null;
  return {
    version: 1,
    viewerId,
    idempotencyKey: record.idempotencyKey,
    ...(record.requestId === undefined ? {} : { requestId: record.requestId as string }),
  };
}
export function createFailurePhase(code: string | undefined, firstWrite: boolean) {
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return 'denied';
  if (code === 'TOO_MANY_REQUESTS') return 'limited';
  if (code === 'BAD_REQUEST' && firstWrite) return 'notAccepted';
  return 'unknown';
}
