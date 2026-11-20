// 성 규모(거점 승격, INT-30). 사용자 2026-11-18 "거점마다 업그레이드가 가능하게 할거야", "승격 자체는 국가 턴으로
// 가능할텐데? 증축, 감축이 가능할거야."(D-109). 서버 home.land.upgrade로 증축, 감축 안내를 보이고, 수뇌면 국가 예턴
// 연속 다섯 칸에 넣는다. 감축은 사라질 건물을 먼저 보이고 한 번 더 눌러야 넣는다. 조건은 서버가 실행할 때 다시 검사한다.
import { useState } from 'react';
import { buildingName, type CityLand } from './CityScene';
import type { ReserveResult } from './LotWindow';
import type { ScaleCommand } from './nationScale';
import styles from './CastleWindow.module.css';

const num = (n: number) => n.toLocaleString('ko-KR');
const COMMAND_NAME: Record<string, string> = { nation_expand: '증축', nation_shrink: '감축' };
const OFFICE_NAME: Record<number, string> = { 12: '군주' };

export type ScaleReserve = (command: ScaleCommand) => Promise<ReserveResult>;

export function UpgradePanel({
  land,
  onReserve,
  nationTurnsHref,
}: {
  land: CityLand;
  /** 없으면 넣기 단추를 막는다. */
  onReserve?: ScaleReserve | undefined;
  /** 국가 예턴 화면 주소. */
  nationTurnsHref?: string | undefined;
}) {
  const [result, setResult] = useState<ReserveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmShrink, setConfirmShrink] = useState(false);
  const up = land.upgrade;
  if (!up?.enabled) return null;
  const { expand, shrink } = up;
  if (!expand.nextGrade && !shrink.previousGrade && !up.preparing.length) return null;
  const reserve = async (command: ScaleCommand) => {
    if (!onReserve) return;
    setBusy(true);
    try {
      setResult(await onReserve(command));
    } catch {
      setResult({ ok: false, message: '국가 예턴에 넣지 못했습니다. 잠시 뒤 다시 눌러 주세요.' });
    } finally {
      setBusy(false);
      setConfirmShrink(false);
    }
  };
  const can = (start: boolean) => up.isChief && start && Boolean(onReserve) && !busy;
  // 이미 준비 중인 명령을 또 넣으면 다섯 칸이 더 쌓여 두 번 적용될 수 있어 막는다.
  const preparing = (command: ScaleCommand) => up.preparing.some((p) => p.commandKey === command);
  return (
    <section className={styles.upgrade} aria-label="성 규모" data-testid="upgrade-panel">
      <div className={styles.upgradeHead}>
        <b>성 규모 {land.grade}</b>
        <span className={styles.note}>
          국가 명령. 같은 명령을 국가 예턴 {up.turns}칸 연속으로 넣으면 마지막 칸에서 실행됩니다.
        </span>
      </div>
      {up.preparing.map((p) => (
        <p key={`${p.commandKey}-${p.officerLevel}`} className={styles.note} role="status">
          {COMMAND_NAME[p.commandKey] ?? p.commandKey} 준비 중({OFFICE_NAME[p.officerLevel] ?? `관직 ${p.officerLevel}`}
          ), 남은 실행 {p.remainingTurns}번
        </p>
      ))}
      {expand.nextGrade ? (
        <div className={styles.upgradeHead}>
          <span>
            <b>증축</b> {land.grade} → {expand.nextGrade}, 국고 금 {num(expand.cost)}
          </span>
          <button
            type="button"
            className="kit-button"
            disabled={!can(expand.canStart) || preparing('nation_expand')}
            onClick={() => void reserve('nation_expand')}
          >
            {preparing('nation_expand') ? '증축 준비 중' : '증축을 국가 예턴에 넣기'}
          </button>
          {expand.failure && !expand.canStart ? <span className={styles.blocked}>{expand.failure.message}</span> : null}
        </div>
      ) : null}
      {shrink.previousGrade ? (
        <div className={styles.upgradeHead}>
          <span>
            <b>감축</b> {land.grade} → {shrink.previousGrade}, 국고 금 {num(shrink.refund)} 돌려받음
          </span>
          <button
            type="button"
            className="kit-button"
            data-kind="secondary"
            disabled={!can(shrink.canStart) || preparing('nation_shrink')}
            onClick={() =>
              confirmShrink || !shrink.demolished.length ? void reserve('nation_shrink') : setConfirmShrink(true)
            }
          >
            {preparing('nation_shrink')
              ? '감축 준비 중'
              : confirmShrink
                ? '철거를 확인하고 넣기'
                : '감축을 국가 예턴에 넣기'}
          </button>
          {shrink.failure && !shrink.canStart ? <span className={styles.blocked}>{shrink.failure.message}</span> : null}
        </div>
      ) : null}
      {shrink.previousGrade && shrink.demolished.length ? (
        <p className={confirmShrink ? styles.blocked : styles.note}>
          감축하면 환급 없이 철거:{' '}
          {shrink.demolished.map((d) => `${buildingName(land, d.building)}(${d.slotId})`).join(', ')}
        </p>
      ) : null}
      {!up.isChief ? <p className={styles.note}>증축과 감축은 수뇌만 넣을 수 있습니다.</p> : null}
      <div className={styles.upgradeHead}>
        {result ? (
          <span className={result.ok ? styles.note : styles.blocked} role="status">
            {result.ok ? `국가 예턴 ${result.slot + 1}~${result.slot + up.turns}번째 칸에 넣었습니다.` : result.message}
          </span>
        ) : null}
        {nationTurnsHref ? (
          <a className={styles.note} href={nationTurnsHref}>
            국가 예턴 열기
          </a>
        ) : null}
      </div>
    </section>
  );
}
