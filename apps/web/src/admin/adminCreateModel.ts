import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

export type CreateOptions = inferRouterOutputs<AppRouter>['admin']['world']['creationOptions'];
export type CreateProfile = Extract<CreateOptions['profiles'][number], { available: true }>;
export type CreateInput = inferRouterInputs<AppRouter>['admin']['world']['create'];
export type CreateReply = inferRouterOutputs<AppRouter>['admin']['world']['createStatus'];
export type CreateDraft = {
  profileId: string;
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
  presetLabel: string;
  presetDescriptions: readonly string[];
  scenarioTitle: string;
  startYear: number;
  counts: Readonly<CreateProfile['counts']>;
  seedMode: 'auto' | 'custom';
  input: Readonly<Omit<CreateInput, 'idempotencyKey'>>;
}>;
export type CreateCommand = Readonly<{ review: CreateReview; input: Readonly<CreateInput> }>;
export type CreatePointer = { version: 1; viewerId: string; idempotencyKey: string; requestId?: string };
export const createDraft = (): CreateDraft => ({
  profileId: '',
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
    readonly field: 'profileId' | 'name' | 'presetKey' | 'turnTerm' | 'endYear' | 'seed',
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
export function reviewCreation(
  options: CreateOptions,
  draft: CreateDraft,
  viewerId: string,
  autoSeed: string,
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
  const input = {
    expectedUserId: viewerId,
    name,
    ...profile.selection,
    presetKey: preset.key,
    turnTermMinutes: integer(draft.turnTerm, 1, 2147483647, 'turnTerm'),
    endYear: draft.endMode === 'none' ? null : integer(draft.endYear, profile.startYear, 10000, 'endYear'),
    seed,
    ruleFeatures: [...profile.ruleFeatures],
  };
  Object.freeze(input.ruleFeatures);
  return Object.freeze({
    revision: options.revision,
    profileId: profile.id,
    presetLabel: preset.label,
    presetDescriptions: Object.freeze([...preset.descriptions]),
    scenarioTitle: profile.scenarioTitle,
    startYear: profile.startYear,
    counts: Object.freeze({ ...profile.counts }),
    seedMode: draft.seedMode,
    input: Object.freeze(input),
  });
}
export function freezeCreation(review: CreateReview, idempotencyKey: string): CreateCommand {
  if (!uuid(idempotencyKey)) throw new Error('요청 번호를 준비하지 못했습니다.');
  const input = { ...review.input, ruleFeatures: [...(review.input.ruleFeatures ?? [])], idempotencyKey };
  Object.freeze(input.ruleFeatures);
  return Object.freeze({ review, input: Object.freeze(input) });
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
