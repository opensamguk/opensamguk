import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useRouteContext } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTRPCClient } from '../trpc';
import { ErrorState, LoadingState } from '../ui/States';
import { usePrivateRead } from './usePrivateRead';
import { AdminClockActions } from './AdminClockActions';
import { AdminEndActions } from './AdminEndActions';
import styles from './AdminPages.module.css';

type Worlds = inferRouterOutputs<AppRouter>['admin']['world']['list'];
const statusNames = { PREOPEN: '개장 전', RUNNING: '진행 중', PAUSED: '일시정지', ENDED: '종료' } as const;
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function AdminWorlds() {
  const viewerId = useRouteContext({ from: '/admin' }).adminViewerId,
    client = useTRPCClient(),
    query = usePrivateRead<Worlds>(viewerId);
  const [owner, setOwner] = useState<'clock' | 'end' | null>(null);
  const ownerRef = useRef<'clock' | 'end' | null>(null);
  const acquireEnd = useCallback(() => {
    if (ownerRef.current !== null && ownerRef.current !== 'end') return false;
    ownerRef.current = 'end';
    setOwner('end');
    return true;
  }, []);
  const releaseEnd = useCallback(() => {
    if (ownerRef.current === 'end') {
      ownerRef.current = null;
      setOwner(null);
    }
  }, []);
  const lockClock = useCallback((locked: boolean) => {
    if (locked && ownerRef.current === null) {
      ownerRef.current = 'clock';
      setOwner('clock');
    } else if (!locked && ownerRef.current === 'clock') {
      ownerRef.current = null;
      setOwner(null);
    }
  }, []);
  useLayoutEffect(() => {
    ownerRef.current = null;
    setOwner(null);
  }, [viewerId]);
  return (
    <section>
      <h2>월드 목록</h2>
      <p>조회 버튼을 누르면 현재 월드와 엔진 기록을 확인합니다. 자동으로 갱신하지 않습니다.</p>
      <button
        type="button"
        disabled={query.pending || owner !== null}
        onClick={() => void query.read((signal) => client.admin.world.list.query(undefined, { signal }))}
      >
        월드 조회
      </button>
      <p>월드 생성·초기화 화면은 준비 중입니다.</p>
      <div inert={owner === 'end'} aria-hidden={owner === 'end' || undefined}>
        <AdminClockActions
          key={viewerId}
          viewerId={viewerId}
          worlds={query.data}
          onClear={query.clear}
          onLockChange={lockClock}
        />
      </div>
      <div inert={owner === 'clock'} aria-hidden={owner === 'clock' || undefined}>
        <AdminEndActions
          key={viewerId}
          viewerId={viewerId}
          worlds={query.data}
          disabled={owner === 'clock'}
          onAcquire={acquireEnd}
          onRelease={releaseEnd}
          onClear={query.clear}
        />
      </div>
      {query.pending ? <LoadingState>월드 조회 중</LoadingState> : null}
      {query.error ? <ErrorState title={query.error} /> : null}
      {query.data ? (
        <>
          <p role="status">{query.data.length}개 월드</p>
          {query.data.length === 0 ? <p>등록된 월드가 없습니다.</p> : null}
          <ul className={styles.worlds} aria-label="월드 조회 결과">
            {query.data.map((world) => (
              <li key={world.id}>
                <h3>{world.name}</h3>
                <dl>
                  <dt>월드 UUID</dt>
                  <dd>
                    <code>{world.id}</code>
                  </dd>
                  <dt>상태</dt>
                  <dd>{statusNames[world.status]}</dd>
                  <dt>시나리오</dt>
                  <dd>{world.scenarioKey}</dd>
                  <dt>프리셋</dt>
                  <dd>{world.presetKey ?? '기본 프리셋'}</dd>
                  <dt>턴 간격</dt>
                  <dd>{world.turnTermMinutes}분</dd>
                  <dt>사람 장수</dt>
                  <dd>{world.humanGenerals}명</dd>
                  {world.heartbeat ? (
                    <>
                      <dt>엔진 기록 시각 (한국)</dt>
                      <dd>
                        <time dateTime={world.heartbeat.at} title={world.heartbeat.at}>
                          {time.format(new Date(world.heartbeat.at))}
                        </time>
                      </dd>
                      <dt>마지막 tick</dt>
                      <dd>{world.heartbeat.lastTick}</dd>
                      <dt>엔진 지연</dt>
                      <dd>{world.heartbeat.lagMs}ms</dd>
                      <dt>엔진 오류</dt>
                      <dd>{world.heartbeat.lastError ?? '기록된 오류 없음'}</dd>
                    </>
                  ) : (
                    <>
                      <dt>엔진 기록</dt>
                      <dd>기록 없음</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : !query.pending && !query.error ? (
        <p>아직 조회하지 않았습니다.</p>
      ) : null}
    </section>
  );
}
