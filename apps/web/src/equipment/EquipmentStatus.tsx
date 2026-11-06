import { EQUIPMENT_SLOTS, type EquipmentRead } from './useEquipment';
import { InfoGrid } from '../main/Panel';
import { ErrorState, LoadingState } from '../ui/States';

export function EquipmentStatus({ read }: { read: EquipmentRead }) {
  // 실패·불러오는 중은 공통 상태 부품을 쓴다. 다시 시도 단추가 모든 폭에서 44px이다 (AC-P2-34).
  if (read.kind === 'loading') return <LoadingState>장비 합산값을 불러오는 중입니다.</LoadingState>;
  if (read.kind === 'error') return <ErrorState title="장비 정보를 불러오지 못했습니다." onRetry={read.retry} />;
  return (
    <section aria-label="장착 장비">
      <h3>장착 장비</h3>
      <InfoGrid
        items={EQUIPMENT_SLOTS.map((slot) => ({
          label: slot.label,
          value: read.data.items.find((item) => item.key === read.data.slots[slot.key])?.name ?? '미장착',
        }))}
      />
    </section>
  );
}
