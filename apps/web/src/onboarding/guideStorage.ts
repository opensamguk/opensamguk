// 첫 턴 안내를 닫았는지 월드별로 기억한다 (INT-20). 화면 상태만 다루며 서버에 보내지 않는다.
// localStorage를 쓸 수 없으면(사생활 모드, 막힌 저장소) 이 탭이 열린 동안만 기억해 한 번만 띄운다.

const guideKey = (worldId: string) => `opensamguk:first-turn-guide:${worldId}`;
const LAST_WORLD_KEY = 'opensamguk:last-world';

// 저장소가 막혔을 때 쓰는 이 탭의 기억. 시험에서 비우도록 내보낸다.
export const sessionMemory = { dismissed: new Set<string>(), lastWorld: null as string | null };

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isGuideDismissed(worldId: string, storage: Storage | null = local()): boolean {
  if (sessionMemory.dismissed.has(worldId)) return true;
  try {
    return storage?.getItem(guideKey(worldId)) === '1';
  } catch {
    return false;
  }
}

export function dismissGuide(worldId: string, storage: Storage | null = local()) {
  sessionMemory.dismissed.add(worldId);
  try {
    storage?.setItem(guideKey(worldId), '1');
  } catch {
    /* 저장하지 못해도 이 탭에서는 다시 띄우지 않는다. */
  }
}

export function resetGuide(worldId: string, storage: Storage | null = local()) {
  sessionMemory.dismissed.delete(worldId);
  try {
    storage?.removeItem(guideKey(worldId));
  } catch {
    /* 지우지 못하면 다음 접속에도 닫힌 채로 남는다. */
  }
}

// 도움말은 월드 주소 밖에 있다. 마지막으로 연 월드를 탭 저장소에 적어 두고 다시 보기 링크에 쓴다.
export function rememberWorld(worldId: string, storage: Storage | null = session()) {
  sessionMemory.lastWorld = worldId;
  try {
    storage?.setItem(LAST_WORLD_KEY, worldId);
  } catch {
    /* 이 탭의 기억만 쓴다. */
  }
}

export function lastWorld(storage: Storage | null = session()): string | null {
  try {
    const stored = storage?.getItem(LAST_WORLD_KEY);
    if (stored) return stored;
  } catch {
    /* 이 탭의 기억으로 넘어간다. */
  }
  return sessionMemory.lastWorld;
}

// 브라우저 자동화(Playwright 등)에서는 자동으로 띄우지 않는다. 기존 E2E가 첫 접속 화면을 그대로 조작하기 때문이다.
export function automated(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}
