// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushRecent, readRecent, RECENT_LIMIT, recentCommandsKey } from './recentCommands';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('최근 넣은 명령 (INT-25)', () => {
  it('계정과 월드마다 키가 다르다', () => {
    expect(recentCommandsKey('u1', 'w1')).not.toBe(recentCommandsKey('u2', 'w1'));
    expect(recentCommandsKey('u1', 'w1')).not.toBe(recentCommandsKey('u1', 'w2'));
  });

  it('새 명령을 앞에 두고 같은 명령·인자는 하나만 남기며 10개까지 둔다', () => {
    let list = pushRecent([], { commandKey: 'move', args: { cityKey: 3 }, explicit: true });
    list = pushRecent(list, { commandKey: 'farm', args: {}, explicit: true });
    list = pushRecent(list, { commandKey: 'move', args: { cityKey: 3 }, explicit: true });
    expect(list).toEqual([
      { commandKey: 'move', args: { cityKey: 3 } },
      { commandKey: 'farm', args: {} },
    ]);
    for (let i = 0; i < 20; i++) list = pushRecent(list, { commandKey: 'move', args: { cityKey: i }, explicit: true });
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toEqual({ commandKey: 'move', args: { cityKey: 19 } });
  });

  it('형식이 맞는 것만 읽고 깨진 값이나 저장소를 못 쓰면 빈 목록이다', () => {
    const key = recentCommandsKey('u1', 'w1');
    localStorage.setItem(
      key,
      JSON.stringify([{ commandKey: 'farm', args: {} }, { commandKey: 3 }, { commandKey: 'move', args: [] }, null]),
    );
    expect(readRecent(key)).toEqual([{ commandKey: 'farm', args: {} }]);
    localStorage.setItem(key, '{깨짐');
    expect(readRecent(key)).toEqual([]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('차단');
    });
    expect(readRecent(key)).toEqual([]);
  });
});
