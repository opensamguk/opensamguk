import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { useWorldMap, useWorldSummary } from '../game/queries';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { useTRPC } from '../trpc';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './CreateGeneralPage.module.css';

// 장수 생성 머리의 서버 정보 한 줄 (INT-25 단계 3, 원작 장수 선택 화면의 서버 정보).
// 정원은 응답에 없어서(entry.roles의 quota.max가 null) 사람 장수 수만 적는다. 못 받은 값은 줄에서 뺀다.
export function WorldStatusLine({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const summary = useWorldSummary(worldId);
  const worlds = useQuery({ ...trpc.lobby.worlds.queryOptions(), retry: retryUnlessClientError });
  const humans = worlds.data?.find((world) => world.id === worldId)?.humanGenerals;
  const parts = [
    summary.data ? `지금 ${formatYearMonth(summary.data.gameDate)}` : null,
    summary.data ? `턴 ${summary.data.turnTermMinutes}분` : null,
    humans === undefined ? null : `사람 장수 ${humans.toLocaleString('ko-KR')}명`,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <p className={styles.worldStatus} data-testid="create-world-status">
      {parts.join(' · ')}
    </p>
  );
}

// 접어 두는 지금 세력 지도. 펼칠 때만 world.map을 받는다.
export function WorldGlanceMap({ worldId }: { worldId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.glance} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>지금 세력 지도</summary>
      {open ? <GlanceMap worldId={worldId} /> : null}
    </details>
  );
}

function GlanceMap({ worldId }: { worldId: string }) {
  const map = useWorldMap(worldId);
  if (map.isError) return <ErrorState title="지도를 불러오지 못했습니다" onRetry={() => void map.refetch()} />;
  if (!map.data) return <LoadingState />;
  return (
    <div className={styles.glanceMap}>
      <WorldMap operationalMap={map.data.operationalMap} cities={map.data.cities} nations={map.data.nations} />
      <MapLegend cities={map.data.cities} nations={map.data.nations} readOnly />
    </div>
  );
}
