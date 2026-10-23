import { errorCode } from './errors';
import type { WorldSummary } from './types';

// 열어 둔 화면이 포커스·새로고침 없이 모드 전환과 기수 종료를 따라오게 하는 갱신 규칙 (T1-27 계획의 갱신 규칙).
// 주기 판단은 여기 순수 함수로 두고 화면은 결과만 쓴다.
export const ACCELERATED_POLL_MS = 5_000;
export const WATCH_POLL_MS = 15_000;

type Watch = Pick<WorldSummary, 'status' | 'clockMode'>;

// 다시 물어도 같은 답이 오는 오류. 이때는 주기 조회를 켜지 않는다. 일시 오류는 기존 재시도 뒤 다음 주기에 다시 묻는다.
const STOP_CODES = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND']);

export const isAccelerated = (world: Watch | undefined) =>
  world?.status === 'RUNNING' && world.clockMode === 'ACCELERATED';

// world.summary 주기. false면 주기 조회를 하지 않는다. ENDED·PREOPEN은 멈춘다.
export function summaryPollMs(world: Watch | undefined, error: unknown): number | false {
  const code = errorCode(error);
  if (code !== undefined && STOP_CODES.has(code)) return false;
  if (isAccelerated(world)) return ACCELERATED_POLL_MS;
  if (world?.status === 'RUNNING' || world?.status === 'PAUSED') return WATCH_POLL_MS;
  return false;
}

// 바로 전 값과 상태나 모드가 다르면 home.get과 기록을 한 번 다시 받는다. 첫 응답은 전환이 아니다.
export function watchChanged(previous: Watch | undefined, next: Watch): boolean {
  return previous !== undefined && (previous.status !== next.status || previous.clockMode !== next.clockMode);
}

// world.summary를 새로 받았을 때 함께 다시 받을 쿼리. 가속 중에는 매번, 그 밖에는 전환 때만.
// 직전 home.get이 NOT_FOUND(내 장수 없음)였으면 가속 중 주기에서는 빼고 전환 때만 받는다.
// 지도·도시·국가(board)는 전환 때만 한 번 받는다. 종료 직후 지도가 결과 칸과 다른 소유국을 보여 주지 않게 하기 위해서다.
export function liveRefresh(
  previous: Watch | undefined,
  next: Watch,
  homeNotFound: boolean,
): { home: boolean; records: boolean; board: boolean } {
  if (watchChanged(previous, next)) return { home: true, records: true, board: true };
  if (previous !== undefined && isAccelerated(next)) return { home: !homeNotFound, records: true, board: false };
  return { home: false, records: false, board: false };
}

const STATUS_TEXT: Record<string, string> = { PREOPEN: '개시 전', PAUSED: '일시 정지', ENDED: '종료' };

// 위쪽 띠의 상태 칸. 가속 중에는 다음 턴 시각이 없으므로 카운트다운 대신 가속 중임을 쓴다.
export function topbarStatus(
  world: Watch | undefined,
  noGeneral: boolean,
  countdown: { seconds: number | null; waiting: boolean },
  remaining: (seconds: number) => string,
): string {
  if (world && world.status !== 'RUNNING') return STATUS_TEXT[world.status] ?? world.status;
  if (isAccelerated(world)) return '가속 진행 중';
  if (noGeneral) return '내 장수 없음';
  if (countdown.seconds !== null)
    return countdown.waiting ? '턴 처리 중' : `다음 턴까지 ${remaining(countdown.seconds)}`;
  return '다음 턴까지 —';
}
