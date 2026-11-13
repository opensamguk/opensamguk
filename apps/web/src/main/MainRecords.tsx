import type { MapCity, MapNation, WorldSummary } from '../game/types';
import { Panel } from './Panel';
import { RECORD_LABELS, RecordList } from './Records';

// 메인 아래 기록 줄 (INT-25, D-085). 원작은 장수 동향 | 개인 기록 | 중원 정세 세 칸이다.
// 장수 동향(온 세상 장수의 공개 행동)은 서버에 조회가 없어(records 라우터는 내 기록·국가 연감·세계 연감뿐) 칸을 비워 두지 않고,
// 지금 칸(개인 기록 · 국가 기록 · 중원 정세)을 그대로 둔다. 중원 정세는 연감에서 만든 사건 글줄이다.
export function MainRecords({
  className,
  worldId,
  clock,
  nations,
  cities,
  hasNation,
}: {
  className?: string | undefined;
  worldId: string;
  clock: WorldSummary | undefined;
  nations: readonly MapNation[];
  cities: readonly MapCity[];
  hasNation: boolean;
}) {
  return (
    <div className={className}>
      <Panel title={RECORD_LABELS.general} area="general-records" headingId="main-general-records">
        <RecordList kind="general" worldId={worldId} clock={clock} nations={nations} compact />
      </Panel>
      <Panel title={RECORD_LABELS.nation} area="nation-records">
        <RecordList kind="nation" worldId={worldId} clock={clock} nations={nations} hasNation={hasNation} compact />
      </Panel>
      <Panel title={RECORD_LABELS.world} area="world-records">
        <RecordList kind="world" worldId={worldId} clock={clock} nations={nations} cities={cities} compact />
      </Panel>
    </div>
  );
}
