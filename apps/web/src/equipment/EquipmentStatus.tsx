import { EQUIPMENT_SLOTS, EQUIPMENT_STATS, type EquipmentBoard, type EquipmentRead } from './useEquipment';
import { InfoGrid } from '../main/Panel';
import { ErrorState, LoadingState } from '../ui/States';

type EquipmentItem = EquipmentBoard['items'][number];

// 장비 효과 글귀 (원작 장수 카드의 장비 효과, 예: 통솔 +3). 이미 받은 equipment.mine의 카탈로그 값만 쓴다.
export const equipmentEffectText = (item: Pick<EquipmentItem, 'stat' | 'bonus'>) =>
  `${EQUIPMENT_STATS[item.stat]} +${item.bonus}`;

// 이름과 효과를 따로 감싼다. 이름만으로 찾는 기존 시험(getByText 정확히 일치)이 그대로 맞는다.
function EquippedItem({
  item,
}: {
  item: (Pick<EquipmentItem, 'name' | 'stat' | 'bonus'> & { description?: string; battleEffect?: string }) | undefined;
}) {
  if (!item) return <>미장착</>;
  return (
    <>
      <span>{item.name}</span>{' '}
      <span data-testid="equipment-effect">({item.description ?? equipmentEffectText(item)})</span>
      {item.battleEffect ? <span> {item.battleEffect}</span> : null}
    </>
  );
}

export function EquipmentStatus({ read }: { read: EquipmentRead }) {
  // 실패·불러오는 중은 공통 상태 부품을 쓴다. 다시 시도 단추가 모든 폭에서 44px이다 (AC-P2-34).
  if (read.kind === 'loading') return <LoadingState>장비 합산값을 불러오는 중입니다.</LoadingState>;
  if (read.kind === 'error') return <ErrorState title="장비 정보를 불러오지 못했습니다." onRetry={read.retry} />;
  return (
    <section aria-label="장착 장비">
      <h3>장착 장비</h3>
      <InfoGrid
        items={[
          ...EQUIPMENT_SLOTS.map((slot) => ({
            label: slot.label,
            value: (
              <EquippedItem
                item={[...read.data.items, ...(read.data.rare ?? [])].find(
                  (item) => item.key === read.data.slots[slot.key],
                )}
              />
            ),
          })),
          ...(read.data.tool
            ? [
                {
                  label: '도구',
                  value: read.data.tool.remainingCharges ? (
                    <span title={read.data.tool.description}>
                      {read.data.tool.name} · {read.data.tool.remainingCharges}회
                    </span>
                  ) : (
                    '미장착'
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
