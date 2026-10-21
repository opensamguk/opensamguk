import { Link } from '@tanstack/react-router';
import { commandName } from '../game/names';
import type { Home } from '../game/types';
import { DisabledReason } from '../ui/DisabledReason';
import { formatClock } from './GeneralInfo';
import styles from './CommandPanel.module.css';

// 실행 예정 시각. 서버가 준 nextTurnAt에서 턴 간격만큼 더해 보여 준다 (표시만, T1-15 계획과 같은 방식).
export function slotTimes(nextTurnAt: string | null, turnTermMinutes: number, count: number): Array<string | null> {
  if (nextTurnAt === null) return Array.from({ length: count }, () => null);
  const start = Date.parse(nextTurnAt);
  if (Number.isNaN(start)) return Array.from({ length: count }, () => null);
  return Array.from({ length: count }, (_, i) => new Date(start + i * turnTermMinutes * 60_000).toISOString());
}

// 메인 명령 칸의 임시 내용. home.get의 앞 5칸을 실행 순서대로 보여 준다.
// 연결 계약(총괄 확정): T1-15가 apps/web/src/turns/TurnEditor.tsx의 TurnEditor({ worldId, selectedCityKey })를 만들면
// MainPage의 명령 칸에서 이 부품 대신 그 편집기를 끼운다. 지도 선택·재조회 때 편집기를 다시 만들지 않는다.
export function CommandPreview({
  worldId,
  home,
  turnTermMinutes,
}: {
  worldId: string;
  home: Home;
  turnTermMinutes: number;
}) {
  const times = slotTimes(home.nextTurnAt, turnTermMinutes, home.turnsPreview.length);
  return (
    <div className={styles.commands}>
      <ol className={styles.list} aria-label="예약한 명령">
        {home.turnsPreview.map((turn, i) => (
          <li key={turn.slot} className={styles.row} data-slot={turn.slot}>
            <span className={`num ${styles.slot}`}>{turn.slot + 1}</span>
            <span className={`num ${styles.time}`}>{formatClock(times[i] ?? null)}</span>
            <span className={styles.command}>{commandName(turn.commandKey)}</span>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <DisabledReason reason="예턴 저장 API(T1-11)와 편집기(T1-15)가 합쳐지면 이 자리에서 30칸을 편집합니다.">
          여기서 편집
        </DisabledReason>
        <Link to="/w/$worldId/turns" params={{ worldId }} className={styles.link}>
          예턴 30칸 보기
        </Link>
      </div>
    </div>
  );
}
