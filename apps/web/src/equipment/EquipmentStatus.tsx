import { EQUIPMENT_SLOTS, type EquipmentRead } from './useEquipment';
import { InfoGrid } from '../main/Panel';

export function EquipmentStatus({ read }: { read: EquipmentRead }) {
  if (read.kind === 'loading') return <p role="status">장비 합산값을 불러오는 중입니다.</p>;
  if (read.kind === 'error')
    return (
      <div role="alert">
        <p>장비 정보를 불러오지 못했습니다.</p>
        <button type="button" onClick={read.retry}>
          다시 조회
        </button>
      </div>
    );
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
