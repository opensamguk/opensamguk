import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { CreationRules, StatKey } from './createForm';
import type { HeritageCheck, HeritageRow, HeritageRules } from './heritage';
import styles from './CreateGeneralPage.module.css';

// 유산 능력치 첩 (T4-96 AC-P2-33). 유산 월드(creationRules.heritage)에서만 그린다.
// 처음 값은 모두 +0이고 화면이 배분을 스스로 채우거나 줄이지 않는다.
export function HeritageAllocation({
  heritage,
  rules,
  result,
  check,
  onStep,
  onRefresh,
}: {
  heritage: HeritageRules;
  rules: CreationRules;
  result: HeritageCheck;
  // stale: 잔액 부족으로 거절되어 사용자가 다시 확인해야 한다. refreshed: 다시 확인했다.
  check: 'ok' | 'stale' | 'refreshed';
  onStep: (key: StatKey, value: number) => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const [announce, setAnnounce] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const pressed = useRef<string | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const balance = useRef<HTMLElement>(null);
  const wasStale = useRef(false);
  const stale = check === 'stale';

  // 누른 단추가 막히면 같은 줄의 반대 단추로 초점을 옮긴다. 막힌 단추에 키보드 초점이 남지 않게 한다.
  useEffect(() => {
    const key = pressed.current;
    pressed.current = null;
    if (!key || !buttons.current.get(key)?.disabled) return;
    const other = buttons.current.get(key.slice(0, -1) + (key.endsWith('+') ? '-' : '+'));
    if (other && !other.disabled) other.focus();
  });

  // 거절 직후에는 「잔액 다시 확인」으로, 확인 뒤에는 보유 칸으로 초점을 옮긴다.
  useEffect(() => {
    if (stale) refreshButton.current?.focus();
    else if (wasStale.current) balance.current?.focus();
    wasStale.current = stale;
  }, [stale]);

  const step = (row: HeritageRow, delta: 1 | -1) => {
    pressed.current = `${row.key}${delta > 0 ? '+' : '-'}`;
    const next = row.bonus + delta;
    const spent = result.spent + delta;
    const after = heritage.balance - spent;
    onStep(row.key, next);
    setAnnounce(
      `${row.label} 유산 +${next}. 최종 ${row.final === null ? '계산 전' : row.final + delta}. 이번 사용 ${spent}점, ${
        after >= 0 ? `사용 뒤 잔액 ${after}점` : `${-after}점 부족`
      }.`,
    );
  };

  return (
    <fieldset className={styles.heritage} aria-describedby={`${id}-help`}>
      <legend>유산 능력치 (선택)</legend>
      <div id={`${id}-help`}>
        <p className={styles.hint}>
          계정의 유산 포인트 1점으로 능력치 하나를 +1 올립니다. 능력치 하나에 +{heritage.perStat}, 이 장수에 합계 +
          {heritage.perGeneral}까지 쓰며 최종 능력치도 최대 {rules.max}까지입니다.
        </p>
        <p className={styles.hint}>
          만든 뒤에는 되돌릴 수 없습니다. 관리자가 이 월드를 강제로 끝내거나 초기화할 때만 돌려받습니다. 쓰지 않은
          점수는 계정에 그대로 남습니다.
        </p>
      </div>
      <dl className={styles.heritageFacts}>
        <div>
          <dt>보유</dt>
          <dd ref={balance} tabIndex={-1}>
            <span className={styles.pixelNum}>{heritage.balance}</span>점
            {stale ? <span className={styles.staleMark}> 다시 확인 필요</span> : null}
          </dd>
        </div>
        <div>
          <dt>이번 사용</dt>
          <dd>
            <span className={styles.pixelNum}>{result.spent}</span>점
          </dd>
        </div>
        <div>
          <dt>사용 뒤 잔액</dt>
          <dd>
            {result.after >= 0 ? (
              <>
                <span className={styles.pixelNum}>{result.after}</span>점
              </>
            ) : (
              <span className={styles.short}>부족 {-result.after}점</span>
            )}
          </dd>
        </div>
        <div>
          <dt>이 장수 한도</dt>
          <dd>
            <span className={styles.pixelNum}>{result.spent}</span> / {heritage.perGeneral}
          </dd>
        </div>
      </dl>
      {heritage.balance === 0 && !stale ? (
        <p className={styles.hint}>
          보유한 유산 포인트가 없습니다. 유산 월드가 통일이나 마지막 해로 끝나면 직접 명령한 게임 달 수에 따라 받습니다.
        </p>
      ) : null}
      {stale ? (
        <div className={styles.heritageStale}>
          <p>다른 월드에서 먼저 썼을 수 있어 보유 점수가 달라졌을 수 있습니다. 배분은 그대로 두었습니다.</p>
          <p>
            <button ref={refreshButton} type="button" className={styles.secondary} onClick={onRefresh}>
              잔액 다시 확인
            </button>
          </p>
        </div>
      ) : check === 'refreshed' ? (
        <p className={styles.heritageOk} role="status">
          잔액을 다시 확인했습니다. 보유 {heritage.balance}점.
        </p>
      ) : null}
      <table className={styles.heritageTable}>
        <caption className={styles.srOnly}>능력치별 기본값, 유산, 최종값</caption>
        <thead>
          <tr>
            <th scope="col">능력치</th>
            <th scope="col" className={styles.n}>
              기본
            </th>
            <th scope="col">유산</th>
            <th scope="col" className={styles.n}>
              최종
            </th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => {
            const whyId = `${id}-${row.key}-why`;
            const over = row.final !== null && row.final > rules.max;
            return (
              <Fragment key={row.key}>
                <tr className={row.why ? styles.hasWhy : undefined}>
                  <th scope="row">{row.label}</th>
                  <td className={`${styles.n} num`}>
                    {row.base === null ? (
                      <>
                        <span aria-hidden="true">?</span>
                        <span className={styles.srOnly}>기본값 없음</span>
                      </>
                    ) : (
                      row.base
                    )}
                  </td>
                  <td>
                    <div className={styles.stepper}>
                      <button
                        ref={(el) => {
                          buttons.current.set(`${row.key}-`, el);
                        }}
                        type="button"
                        className={styles.step}
                        aria-label={`${row.label} 유산 줄이기`}
                        disabled={row.bonus === 0}
                        onClick={() => step(row, -1)}
                      >
                        −
                      </button>
                      {/* output은 status 역할이라 아래 알림과 겹쳐 읽히므로 span을 쓴다. */}
                      <span className={`${styles.heritageValue} ${row.bonus === 0 ? styles.muted : ''}`}>
                        +{row.bonus}
                      </span>
                      <button
                        ref={(el) => {
                          buttons.current.set(`${row.key}+`, el);
                        }}
                        type="button"
                        className={styles.step}
                        aria-label={`${row.label} 유산 늘리기`}
                        aria-describedby={row.why ? whyId : undefined}
                        disabled={row.why !== null}
                        onClick={() => step(row, 1)}
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td className={styles.n}>
                    {row.final === null ? (
                      <>
                        <span aria-hidden="true">?</span>
                        <span className={styles.srOnly}>계산 전</span>
                      </>
                    ) : (
                      <>
                        <strong className={`${styles.pixelNum} ${over ? styles.over : ''}`}>{row.final}</strong>
                        {over ? <span className={styles.srOnly}> 최대 {rules.max} 초과</span> : null}
                      </>
                    )}
                  </td>
                </tr>
                {row.why ? (
                  <tr className={styles.heritageWhy}>
                    <td colSpan={4} id={whyId}>
                      {row.why}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className={styles.srOnly} aria-live="polite">
        {announce}
      </p>
    </fieldset>
  );
}
