// 칸마다 실행 예정 시기. 서버가 준 값만 쓴다 (UI 지침: 턴 시각은 서버가 준 값만 보여 준다).
// 시각: home.get의 nextTurnAt(첫 칸) + 칸 번호 × 턴 간격. 월드가 멈췄으면 nextTurnAt이 null이고 시각은 비운다.
// 연월: 장수의 nextTurnTick과 world.summary의 현재 연월·tick·tick 길이로 센다. 1칸 = 게임 1개월.

export interface Clock {
  gameDate: { year: number; month: number };
  nowTick: number;
  msPerTick: number;
  turnTermMinutes: number;
}

export interface SlotTime {
  date: string | null;
  time: string | null;
  iso: string | null;
}

export function slotTimes(
  count: number,
  clock: Clock | undefined,
  nextTurnTick: number | undefined,
  nextTurnAt: string | null | undefined,
  now = new Date(),
): SlotTime[] {
  const termMs = clock ? clock.turnTermMinutes * 60_000 : 0;
  const ticksPerMonth = clock && clock.msPerTick > 0 ? Math.round(termMs / clock.msPerTick) : 0;
  const first = nextTurnAt ? Date.parse(nextTurnAt) : Number.NaN;
  return Array.from({ length: count }, (_, i) => {
    let date: string | null = null;
    if (clock && ticksPerMonth > 0 && nextTurnTick !== undefined) {
      const nowIndex = clock.gameDate.year * 12 + (clock.gameDate.month - 1);
      const index =
        nowIndex -
        Math.floor(clock.nowTick / ticksPerMonth) +
        Math.floor((nextTurnTick + i * ticksPerMonth) / ticksPerMonth);
      date = `${Math.floor(index / 12)}년 ${(index % 12) + 1}월`;
    }
    if (!Number.isFinite(first) || termMs <= 0) return { date, time: null, iso: null };
    const at = new Date(first + i * termMs);
    return { date, time: formatTime(at, now), iso: at.toISOString() };
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

// 오늘이면 시:분, 다른 날이면 월·일을 앞에 붙인다.
export function formatTime(at: Date, now: Date): string {
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}
