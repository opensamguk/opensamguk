import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { PolicyBar } from '../policy/PolicyBar';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from './apiError';
import { slotTimes } from './schedule';
import { homePollMs, TurnEditor } from './TurnEditor';
import styles from './TurnsPage.module.css';

// /w/:worldId/turns. 메인 명령 칸과 같은 편집기를 넓게 쓰는 보조 화면이다 (핵심 조작은 메인에서 한다).
// 오른쪽에는 엔진이 실행한 최근 결과를 둔다. 실행 때 다시 검사해 실패하면 그 이유가 여기 남는다 (AC-M1-09).
export function TurnsPage() {
  const { worldId } = useParams({ from: '/w/$worldId' });
  return (
    <section className={styles.page}>
      <h1>예턴 편집</h1>
      <div className={styles.layout}>
        <div className={styles.editorColumn}>
          <PolicyBar worldId={worldId} />
          <TurnEditor worldId={worldId} selectedCityKey={null} />
        </div>
        <RecentResults worldId={worldId} />
      </div>
    </section>
  );
}

function RecentResults({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const summary = useQuery({ ...trpc.world.summary.queryOptions({ worldId }), retry: retryUnlessClientError });
  const home = useQuery({
    ...trpc.home.get.queryOptions({ worldId }),
    refetchInterval: homePollMs(summary.data?.status === 'ENDED'),
    retry: retryUnlessClientError,
  });
  const logs = home.data?.recentLogs ?? [];
  return (
    <section className={styles.results} aria-labelledby="recent-results">
      <h2 id="recent-results">최근 실행 결과</h2>
      {!home.data ? (
        <p className={styles.muted}>{home.isError ? '불러오지 못했습니다.' : '불러오는 중…'}</p>
      ) : logs.length === 0 ? (
        <p className={styles.muted}>아직 실행한 턴이 없습니다.</p>
      ) : (
        <ol className={styles.logs} data-testid="recent-results">
          {logs.map((log) => {
            const date = summary.data ? slotTimes(1, summary.data, log.tick, null)[0]?.date : null;
            return (
              <li key={log.id} className={log.kind === 'failure' ? styles.failure : undefined}>
                <span className={styles.logHead}>
                  {date ?? ''} {log.kind === 'failure' ? '실패' : '실행'}
                </span>
                <span className={styles.logText}>{readableLog(log.text)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// 실패 기록은 엔진이 `코드: 이유`로 남긴다. 화면에는 이유만 보인다.
function readableLog(text: string): string {
  return text.replace(/^[A-Z][A-Z_]*: /, '');
}
