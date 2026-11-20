import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthForm } from '../auth/AuthForm';
import { AuthScreen } from '../auth/AuthScreen';
import styles from '../auth/AuthPage.module.css';
import { WorldTicker } from '../lobby/WorldTicker';
import { PublicMapTabs } from '../publicMap/PublicMapTabs';
import { useTRPC } from '../trpc';

const route = getRouteApi('/login');

export function LoginPage() {
  const { next } = route.useSearch();
  const trpc = useTRPC();
  const health = useQuery(trpc.health.queryOptions());
  // 공개 지도 탭에서 고른 월드의 중원 정세 띠(INT-29). 이름은 로비 목록(공개)에서 찾는다.
  const worlds = useQuery(trpc.lobby.worlds.queryOptions());
  const [worldId, setWorldId] = useState<string | null>(null);
  const shown = worldId ?? worlds.data?.find((world) => world.status !== 'ENDED')?.id ?? null;

  // 계정 화면 틀(INT-29 화면 개편): 표지 그림 위 로고, 가운데 창에 양식, 오른쪽 카드에 공개 지도 탭, 아래 중원 정세 띠.
  // 좁은 화면에서는 공개 지도 카드가 양식 아래로 내려간다.
  return (
    <AuthScreen
      title="로그인"
      aside={<PublicMapTabs selectedId={worldId} onSelect={setWorldId} />}
      footer={
        <WorldTicker
          worldId={shown}
          worldName={worlds.data?.find((world) => world.id === shown)?.name ?? ''}
          loggedIn={false}
        />
      }
    >
      <AuthForm mode="login" next={next} />
      <p className={styles.switch}>
        <Link to="/forgot-password">비밀번호를 잊었습니다</Link>
      </p>
      <p className={styles.switch}>
        계정이 없으면{' '}
        <Link to="/signup" search={next ? { next } : {}}>
          가입하기
        </Link>
      </p>
      <p role="status" className={styles.status}>
        {statusText(health)}
      </p>
    </AuthScreen>
  );
}

function statusText(health: { isPending: boolean; isError: boolean; data: { db: 'ok' | 'down' } | undefined }): string {
  if (health.isPending) return '서버 확인 중…';
  if (health.isError || !health.data) return '서버에 연결할 수 없습니다';
  return health.data.db === 'ok' ? '서버 정상 · DB 정상' : '서버 정상 · DB 연결 안 됨';
}
