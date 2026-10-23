import { useCallback, useSyncExternalStore } from 'react';

// 메시지 작성 칸·공지 고치기 초안·고른 탭을 query 캐시 밖에 둔다 (계획 T2-10 "결정", 검토 R63-4).
// SSE의 ready 전체 재조회나 패널 접기·펴기로 부품이 다시 만들어져도 이 탭이 열려 있는 동안 남는다.
// 새로고침하면 사라진다. 메시지 본문을 브라우저 저장소에 남기지 않기 위해서다.

const values = new Map<string, unknown>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 처음 읽을 때 기본값을 넣어 둔다. useSyncExternalStore는 같은 값이면 같은 참조를 돌려받아야 한다.
export function readDraft<T>(key: string, initial: T): T {
  if (!values.has(key)) values.set(key, initial);
  return values.get(key) as T;
}

export function writeDraft<T>(key: string, value: T) {
  values.set(key, value);
  notify();
}

export function clearDrafts() {
  values.clear();
  notify();
}

export function useDraft<T>(key: string, initial: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readDraft(key, initial),
    () => initial,
  );
  const set = useCallback((next: T) => writeDraft(key, next), [key]);
  return [value, set];
}
