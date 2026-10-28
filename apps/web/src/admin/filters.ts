import type { inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

type Inputs = inferRouterInputs<AppRouter>['admin'];
export type AuditFilter = Omit<Inputs['audit']['list'], 'cursor'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();

export function searchFilter(data: FormData): Inputs['user']['search'] {
  if (text(data, 'kind') === 'general') {
    const worldId = text(data, 'worldId'),
      generalName = text(data, 'generalName');
    if (!uuid.test(worldId) || !generalName || generalName.length > 30)
      throw new Error('월드 UUID와 장수 이름 앞부분1~30자를 입력하세요.');
    return { query: { worldId, generalName } };
  }
  const query = text(data, 'query');
  if (query.length < 3 || query.length > 254) throw new Error('이메일 앞부분3~254자 또는 사용자 UUID를 입력하세요.');
  return { query };
}

// datetime-local의 입력을 운영 화면에 명시한 한국 시각으로 해석한다.
export function koreanDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('날짜와 시각을 확인하세요.');
  const date = new Date(value + ':00+09:00');
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16) !== value
  )
    throw new Error('날짜와 시각을 확인하세요.');
  return date.toISOString();
}

export function auditFilter(data: FormData): AuditFilter {
  const filter: AuditFilter = {};
  for (const name of ['from', 'to'] as const) {
    const value = text(data, name);
    if (value) filter[name] = koreanDate(value);
  }
  if (filter.from && filter.to && filter.from > filter.to) throw new Error('시작 시각은 끝 시각보다 앞이어야 합니다.');
  for (const name of ['actorUserId', 'worldId'] as const) {
    const value = text(data, name);
    if (value && !uuid.test(value)) throw new Error('행위자와 월드는 UUID로 입력하세요.');
    if (value) filter[name] = value;
  }
  const action = text(data, 'action'),
    targetId = text(data, 'targetId');
  if (action && (action.length > 100 || !/^[a-z][a-z0-9.]*$/.test(action))) throw new Error('행위 종류를 확인하세요.');
  if (targetId.length > 200) throw new Error('대상은200자 이하로 입력하세요.');
  if (action) filter.action = action;
  if (targetId) filter.targetId = targetId;
  return filter;
}
