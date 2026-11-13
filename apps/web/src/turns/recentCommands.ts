import { useCallback, useState } from 'react';
import { turnKey, type Turn } from './draft';

// 최근 넣은 명령 (원작 예턴 편집기의 최근 실행, INT-25). 원작처럼 서버에 두지 않고 브라우저 localStorage에만 둔다.
// 계정·월드마다 따로 두며, 개인 칸과 국가 칸이 같은 키를 쓴다. 그리는 쪽이 지금 명령 목록에 있는 것만 보인다.

const PREFIX = 'opensamguk.recentCommands.v1';
export const RECENT_LIMIT = 10;

export interface RecentCommand {
  commandKey: string;
  args: Record<string, unknown>;
}

export const recentCommandsKey = (userId: string, worldId: string) => `${PREFIX}:${userId}:${worldId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 저장소를 못 쓰거나(사생활 보호 창·차단) 값이 깨졌으면 빈 목록이다.
export function readRecent(key: string): RecentCommand[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentCommand =>
          isRecord(item) && typeof item.commandKey === 'string' && item.commandKey !== '' && isRecord(item.args),
      )
      .map(({ commandKey, args }) => ({ commandKey, args }))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function writeRecent(key: string, list: readonly RecentCommand[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // 저장소를 못 쓰면 이 화면에서만 기억한다.
  }
}

// 새로 넣은 명령을 맨 앞에 둔다. 같은 명령·인자는 하나만 남기고 10개까지 둔다.
export function pushRecent(list: readonly RecentCommand[], turn: Turn): RecentCommand[] {
  const entry: RecentCommand = { commandKey: turn.commandKey, args: { ...turn.args } };
  const key = turnKey({ ...entry, explicit: true });
  return [entry, ...list.filter((item) => turnKey({ ...item, explicit: true }) !== key)].slice(0, RECENT_LIMIT);
}

export function useRecentCommands(key: string): [RecentCommand[], (turn: Turn) => void] {
  const [list, setList] = useState(() => readRecent(key));
  const remember = useCallback(
    (turn: Turn) => {
      // 비워 둔 칸(기본 방침)은 명령이 아니므로 남기지 않는다.
      if (!turn.explicit) return;
      setList((prev) => {
        const next = pushRecent(prev, turn);
        writeRecent(key, next);
        return next;
      });
    },
    [key],
  );
  return [list, remember];
}
