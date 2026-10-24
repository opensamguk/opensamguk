import type { WorldSummary } from './types';

// 기록의 tick을 게임 연월로 바꿔 보여 준다. 월드 요약이 준 현재 연월·tick·tick 길이만 쓴다.
// 한 달의 tick 수는 turnTermMinutes와 msPerTick에서 나온다 (둘 다 서버 값).
export interface YearMonth {
  year: number;
  month: number;
}

type Clock = Pick<WorldSummary, 'gameDate' | 'nowTick' | 'msPerTick' | 'turnTermMinutes'>;

export function tickDate(tick: number, clock: Clock): YearMonth | null {
  if (!(clock.msPerTick > 0)) return null;
  const ticksPerMonth = Math.round((clock.turnTermMinutes * 60_000) / clock.msPerTick);
  if (!(ticksPerMonth > 0)) return null;
  const nowIndex = clock.gameDate.year * 12 + (clock.gameDate.month - 1);
  const index = nowIndex - Math.floor(clock.nowTick / ticksPerMonth) + Math.floor(tick / ticksPerMonth);
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

type LogClock = Pick<WorldSummary, 'startYear' | 'msPerTick' | 'turnTermMinutes'>;

// 개인 로그 한 줄의 연월. 로그 tick을 월드 시작 연도부터 센다 (T1-27 후속).
// 결과가 있는 종료 월드는 gameDate가 결과 연월이고 nowTick이 저장 시계라 tickDate의 상대식이 한 달 이상 어긋난다.
export function personalLogDate(tick: number, clock: LogClock): YearMonth | null {
  if (!(clock.msPerTick > 0)) return null;
  const ticksPerMonth = Math.round((clock.turnTermMinutes * 60_000) / clock.msPerTick);
  if (!(ticksPerMonth > 0)) return null;
  const index = clock.startYear * 12 + Math.floor(tick / ticksPerMonth);
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export const formatYearMonth = (date: YearMonth | null) => (date === null ? '—' : `${date.year}년 ${date.month}월`);
