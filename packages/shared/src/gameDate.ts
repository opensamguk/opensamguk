// 게임 달력. 1턴 = 게임 1개월이며, 12월 다음은 다음 해 1월이다.
export interface GameDate {
  readonly year: number;
  readonly month: number;
}

export function nextMonth(date: GameDate): GameDate {
  return date.month === 12 ? { year: date.year + 1, month: 1 } : { year: date.year, month: date.month + 1 };
}

export function formatGameDate(date: GameDate): string {
  return `${date.year}년 ${date.month}월`;
}
