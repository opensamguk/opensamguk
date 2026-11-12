import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { josa } from '../mapEditor/josa';

export type Advice = inferRouterOutputs<AppRouter>['advice']['get'];
export type AdviceItem = Advice['items'][number];

// 색은 보조이고 출처는 글자로 먼저 쓴다.
export const SOURCE_LABEL: Record<AdviceItem['source'], string> = {
  operation: '작전',
  notice: '지시',
  ai: '조언',
};

export const ENDED_REASON = '끝난 판이라 예턴을 바꿀 수 없습니다.';
export const DRAFT_REASON = '편집 중인 예턴을 저장하거나 취소하면 넣을 수 있습니다';
export const STALE_TEXT = '다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.';

export const adviceItemKey = (item: AdviceItem) => `${item.source}:${item.commandKey}:${JSON.stringify(item.args)}`;

export const putLabel = (item: AdviceItem) => (item.commandKey === 'join' ? '임관 넣기' : '1칸에 넣기');

export const replaceText = (slotName: string, commandName: string) =>
  `1칸의 ${josa(slotName, '을/를')} ${josa(commandName, '으로/로')} 바꿉니다`;

// 사용자가 바꾼 펼침 상태는 월드별로 둔다. 없으면 서버가 준 기본값을 쓴다.
export const expandedStorageKey = (worldId: string) => `opensamguk.advice.expanded.v1:${worldId}`;

export function readExpanded(storage: Storage | undefined, worldId: string): boolean | null {
  try {
    const raw = storage?.getItem(expandedStorageKey(worldId));
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeExpanded(storage: Storage | undefined, worldId: string, value: boolean) {
  try {
    storage?.setItem(expandedStorageKey(worldId), value ? '1' : '0');
  } catch {
    // 저장 공간이 막혀 있어도 이번 화면에서는 바뀐 상태를 쓴다.
  }
}

export function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export interface PutGuard {
  ended: boolean;
  saving: boolean;
  pending: boolean;
  hasDraft: boolean;
  serverRevision: number | undefined;
  basisRevision: number;
  fetching: boolean;
  putting: boolean;
}

// 넣기를 막는 이유. 없으면 null이다. 초안은 조언이 덮거나 대신 저장하지 않는다.
export function putBlockedReason(g: PutGuard): string | null {
  if (g.ended) return ENDED_REASON;
  if (g.putting) return '넣는 중입니다.';
  if (g.saving) return '저장하는 중입니다.';
  if (g.pending) return '먼저 편집기의 충돌 안내에서 다시 적용할지 고르세요.';
  if (g.hasDraft) return DRAFT_REASON;
  if (g.serverRevision === undefined) return '예턴을 불러온 뒤에 넣을 수 있습니다.';
  if (g.fetching || g.serverRevision !== g.basisRevision) return '예턴이 바뀌어 조언을 다시 받는 중입니다.';
  return null;
}
