import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { formatRemaining } from './countdown';
import {
  ACCELERATED_POLL_MS,
  liveRefresh,
  summaryPollMs,
  topbarStatus,
  WATCH_POLL_MS,
  watchChanged,
} from './worldWatch';

const clientError = (code: string) => new TRPCClientError(code, { result: { error: { data: { code } } } } as never);
const world = (status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED', clockMode: 'REALTIME' | 'ACCELERATED') => ({
  status,
  clockMode,
});

describe('월드 감시 주기 (T1-27)', () => {
  it('가속 진행 중은 5초, 실시간·정지는 15초마다 다시 묻는다', () => {
    expect(summaryPollMs(world('RUNNING', 'ACCELERATED'), null)).toBe(ACCELERATED_POLL_MS);
    expect(summaryPollMs(world('RUNNING', 'REALTIME'), null)).toBe(WATCH_POLL_MS);
    expect(summaryPollMs(world('PAUSED', 'REALTIME'), null)).toBe(WATCH_POLL_MS);
    // 정지 중에 가속으로 바꿔도 재개 전까지는 15초다. 재개를 감지하면 5초로 바뀐다.
    expect(summaryPollMs(world('PAUSED', 'ACCELERATED'), null)).toBe(WATCH_POLL_MS);
  });

  it('끝난 판·개시 전·첫 응답 전에는 주기 조회를 켜지 않는다', () => {
    expect(summaryPollMs(world('ENDED', 'ACCELERATED'), null)).toBe(false);
    expect(summaryPollMs(world('ENDED', 'REALTIME'), null)).toBe(false);
    expect(summaryPollMs(world('PREOPEN', 'REALTIME'), null)).toBe(false);
    expect(summaryPollMs(undefined, null)).toBe(false);
  });

  it('다시 물어도 같은 오류면 멈추고 일시 오류는 마지막 값의 주기를 이어 간다', () => {
    for (const code of ['NOT_FOUND', 'UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST'])
      expect(summaryPollMs(world('RUNNING', 'ACCELERATED'), clientError(code))).toBe(false);
    expect(summaryPollMs(world('RUNNING', 'ACCELERATED'), new Error('네트워크'))).toBe(ACCELERATED_POLL_MS);
    expect(summaryPollMs(world('PAUSED', 'REALTIME'), clientError('INTERNAL_SERVER_ERROR'))).toBe(WATCH_POLL_MS);
  });
});

describe('전환 감지와 함께 받을 쿼리', () => {
  it('첫 응답은 전환이 아니고 상태나 모드가 바뀌면 전환이다', () => {
    expect(watchChanged(undefined, world('RUNNING', 'REALTIME'))).toBe(false);
    expect(watchChanged(world('RUNNING', 'REALTIME'), world('RUNNING', 'REALTIME'))).toBe(false);
    expect(watchChanged(world('RUNNING', 'REALTIME'), world('RUNNING', 'ACCELERATED'))).toBe(true);
    expect(watchChanged(world('PAUSED', 'ACCELERATED'), world('RUNNING', 'ACCELERATED'))).toBe(true);
    expect(watchChanged(world('RUNNING', 'ACCELERATED'), world('ENDED', 'ACCELERATED'))).toBe(true);
  });

  it('전환 때는 장수가 없어도 home.get·기록·지도를 한 번 받는다', () => {
    expect(liveRefresh(world('RUNNING', 'REALTIME'), world('RUNNING', 'ACCELERATED'), true)).toEqual({
      home: true,
      records: true,
      board: true,
    });
    expect(liveRefresh(world('RUNNING', 'ACCELERATED'), world('ENDED', 'ACCELERATED'), true)).toEqual({
      home: true,
      records: true,
      board: true,
    });
  });

  it('가속 중 주기에서는 기록을 받고 장수가 없으면 home.get은 뺀다', () => {
    const accelerated = world('RUNNING', 'ACCELERATED');
    expect(liveRefresh(accelerated, accelerated, false)).toEqual({ home: true, records: true, board: false });
    expect(liveRefresh(accelerated, accelerated, true)).toEqual({ home: false, records: true, board: false });
  });

  it('실시간·정지·끝난 판에서 같은 값을 다시 받으면 더 받지 않는다', () => {
    for (const same of [world('RUNNING', 'REALTIME'), world('PAUSED', 'ACCELERATED'), world('ENDED', 'ACCELERATED')])
      expect(liveRefresh(same, same, false)).toEqual({ home: false, records: false, board: false });
    expect(liveRefresh(undefined, world('RUNNING', 'ACCELERATED'), false)).toEqual({
      home: false,
      records: false,
      board: false,
    });
  });
});

describe('위쪽 띠 상태 칸', () => {
  const idle = { seconds: null, waiting: false };
  it('가속 중에는 카운트다운 대신 가속 진행 중을 쓴다', () => {
    expect(topbarStatus(world('RUNNING', 'ACCELERATED'), false, { seconds: 90, waiting: false }, formatRemaining)).toBe(
      '가속 진행 중',
    );
    expect(topbarStatus(world('RUNNING', 'ACCELERATED'), true, idle, formatRemaining)).toBe('가속 진행 중');
  });

  it('끝난 판은 종료, 정지는 모드와 상관없이 일시 정지다', () => {
    expect(topbarStatus(world('ENDED', 'ACCELERATED'), false, idle, formatRemaining)).toBe('종료');
    expect(topbarStatus(world('PAUSED', 'ACCELERATED'), false, idle, formatRemaining)).toBe('일시 정지');
  });

  it('실시간 진행은 지금처럼 장수 없음이나 남은 시간을 쓴다', () => {
    expect(topbarStatus(world('RUNNING', 'REALTIME'), true, idle, formatRemaining)).toBe('내 장수 없음');
    expect(topbarStatus(world('RUNNING', 'REALTIME'), false, { seconds: 90, waiting: false }, formatRemaining)).toBe(
      '다음 턴까지 1:30',
    );
    expect(topbarStatus(world('RUNNING', 'REALTIME'), false, { seconds: 0, waiting: true }, formatRemaining)).toBe(
      '턴 처리 중',
    );
    expect(topbarStatus(undefined, false, idle, formatRemaining)).toBe('다음 턴까지 —');
  });
});
