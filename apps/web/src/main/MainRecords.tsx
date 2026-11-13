import type { MapCity, MapNation, WorldSummary } from '../game/types';
import styles from './MainRecords.module.css';
import { Panel } from './Panel';
import { ActivityFeed, RECORD_LABELS, RecordList, WorldFeed } from './Records';

// 메인 아래 기록 줄 (INT-25, D-085). 원작처럼 장수 동향 | 개인 기록 | 중원 정세 세 칸이다.
// 장수 동향과 중원 정세는 서버 사건 조회(records.activity scope all · world, INT-26)를 쓴다.
// 월별 국가 수치(국가 기록)는 메인에서 빠지고 기록 화면의 국가 역사 탭(/w/:worldId/records?tab=nation)에 남는다.
export function MainRecords({
  className,
  worldId,
  clock,
  nations,
  cities,
}: {
  className?: string | undefined;
  worldId: string;
  clock: WorldSummary | undefined;
  nations: readonly MapNation[];
  cities: readonly MapCity[];
  // 국가 기록 칸이 있던 때의 값. 메인 쪽 호출을 바꾸지 않도록 받기만 한다.
  hasNation?: boolean;
}) {
  return (
    <div className={className ? `${className} ${styles.strip}` : styles.strip}>
      <Panel title={RECORD_LABELS.activity} area="activity-records">
        <ActivityFeed worldId={worldId} compact />
      </Panel>
      <Panel title={RECORD_LABELS.general} area="general-records" headingId="main-general-records">
        <RecordList kind="general" worldId={worldId} clock={clock} nations={nations} compact />
      </Panel>
      <Panel title={RECORD_LABELS.world} area="world-records">
        <WorldFeed worldId={worldId} clock={clock} nations={nations} cities={cities} compact />
      </Panel>
    </div>
  );
}
