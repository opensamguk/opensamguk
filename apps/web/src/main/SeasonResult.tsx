import type { WorldSummary } from '../game/types';
import { NationBadge } from '../ui/NationBadge';
import styles from './SeasonResult.module.css';

export const END_REASON_TEXT = { UNIFIED: '천하통일', END_YEAR: '종료 연도 도달' } as const;

// 끝난 판의 결과 칸 (T1-27). 값은 모두 서버의 world.summary.result에서 읽는다.
// 승자는 국가색만으로 구별하지 않게 이름표에 이름을 함께 쓴다. 결과 기록이 없는 예전 종료 월드는 끝났다는 것만 알린다.
export function SeasonResult({ result }: { result: WorldSummary['result'] }) {
  if (result === null) {
    return (
      <section className={styles.result} aria-label="기수 결과">
        <p className={styles.lead}>이 판은 끝났습니다.</p>
      </section>
    );
  }
  return (
    <section className={styles.result} aria-labelledby="season-result-title">
      <h2 id="season-result-title" className={styles.title}>
        기수 결과
      </h2>
      <dl className={styles.grid}>
        <div className={styles.cell}>
          <dt>끝난 이유</dt>
          <dd data-testid="season-reason">{END_REASON_TEXT[result.reason]}</dd>
        </div>
        <div className={styles.cell}>
          <dt>승자</dt>
          <dd data-testid="season-winner">
            {result.winner ? <NationBadge name={result.winner.name} color={result.winner.color} /> : '승자 없음'}
          </dd>
        </div>
        <div className={styles.cell}>
          <dt>종료 연월</dt>
          <dd className="num" data-testid="season-date">
            {result.year}년 {result.month}월
          </dd>
        </div>
        <div className={styles.cell}>
          <dt>남은 국가</dt>
          <dd className="num" data-testid="season-nations">
            {result.remainingNations}
          </dd>
        </div>
      </dl>
      <p className={styles.lead}>지도와 기록은 그대로 볼 수 있고 예턴은 더 바꿀 수 없습니다.</p>
    </section>
  );
}
