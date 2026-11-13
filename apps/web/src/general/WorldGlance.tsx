import { useState } from 'react';
import { formatYearMonth } from '../game/gameDate';
import { useWorldMap, useWorldSummary } from '../game/queries';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { humanQuotaText } from '../main/mainProgress';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './CreateGeneralPage.module.css';

// 장수 생성 머리의 서버 정보 한 줄 (INT-25 단계 3, 원작 장수 선택 화면의 서버 정보).
export function WorldStatusLine({ worldId }: { worldId: string }) {
  const summary = useWorldSummary(worldId);
  const parts = [
    summary.data ? `지금 ${formatYearMonth(summary.data.gameDate)}` : null,
    summary.data ? `턴 ${summary.data.turnTermMinutes}분` : null,
    humanQuotaText(summary.data?.quota),
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
      {map.data.nations.length > 0 ? (
        <section aria-label="국가별 임관 권유문">
          <h3>국가별 임관 권유문</h3>
          <dl>
            {map.data.nations.map((nation) => (
              <div key={nation.id}>
                <dt>{nation.name}</dt>
                <dd>{nation.recruitmentNotice || '임관 권유문 없음'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
