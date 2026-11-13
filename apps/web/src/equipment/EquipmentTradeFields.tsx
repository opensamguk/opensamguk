import type { RefObject } from 'react';
import { EQUIPMENT_SLOTS, EQUIPMENT_STATS, type EquipmentRead } from './useEquipment';
import styles from '../turns/TurnEditor.module.css';
import tradeStyles from './EquipmentTradeFields.module.css';
import { ErrorState, LoadingState } from '../ui/States';

// 선택은 기존 편집기의 문자열 인자만 바꾼다. 실제 매매는 예턴 저장·실행 경로가 처리한다.
export const equipmentUiSchema = {
  type: 'object',
  required: ['slot', 'itemKey'],
  properties: {
    slot: { type: 'string', enum: ['horse', 'weapon', 'book'] },
    itemKey: { type: 'string', maxLength: 9 },
  },
};
const n = (value: number) => value.toLocaleString('ko-KR');

export function EquipmentTradeFields({
  read,
  values,
  onChange,
  firstArgRef,
  security,
}: {
  read: EquipmentRead | undefined;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  firstArgRef: RefObject<HTMLElement | null>;
  // 내 도시의 지금 치안 (home.get). 장비별 요구 치안과 견준다. 모르면 적지 않는다.
  security?: number | undefined;
}) {
  // 실패·불러오는 중은 공통 상태 부품을 쓴다. 다시 시도 단추가 모든 폭에서 44px이다 (AC-P2-34).
  if (read?.kind === 'error') return <ErrorState title="장비 정보를 불러오지 못했습니다." onRetry={read.retry} />;
  if (read?.kind !== 'ready') return <LoadingState>장비 정보를 불러오는 중입니다.</LoadingState>;
  const board = read.data,
    slot = EQUIPMENT_SLOTS.find((row) => row.key === values.slot)?.key ?? 'horse';
  // 지금 살 수 있는 장비를 앞에 둔다. 못 사는 장비도 예약할 수 있어 목록에 남기고 (불가)를 붙인다 (INT-25).
  const items = board.items
    .filter((item) => item.slot === slot)
    .sort((a, b) => Number(a.failure !== null) - Number(b.failure !== null));
  const item = items.find((row) => row.key === values.itemKey);
  const sale = board.sales.find((row) => row.slot === slot)!;
  const selling = values.itemKey === 'none';
  const held = board.items.find((row) => row.key === board.slots[slot]);
  const materials = item
    ? [
        item.goods.iron ? `철 ${n(item.goods.iron)}` : '',
        item.goods.wood ? `목재 ${n(item.goods.wood)}` : '',
        item.goods.horses ? `말 ${n(item.goods.horses)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const failure = selling ? sale.failure : item?.failure;
  return (
    <div className={tradeStyles.trade}>
      <div className={tradeStyles.fields}>
        <label className={styles.argLabel}>
          <span>장비 칸</span>
          <select
            ref={(node) => {
              firstArgRef.current = node;
            }}
            value={slot}
            onChange={(event) => onChange({ slot: event.target.value, itemKey: '' })}
          >
            {EQUIPMENT_SLOTS.map((row) => (
              <option key={row.key} value={row.key}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.argLabel}>
          <span>매매할 장비</span>
          <select
            value={item || selling ? values.itemKey : ''}
            onChange={(event) => onChange({ slot, itemKey: event.target.value })}
          >
            <option value="">장비 선택</option>
            {items.map((row) => (
              <option key={row.key} value={row.key}>
                {row.name} · 금 {n(row.cost)} · {EQUIPMENT_STATS[row.stat]} +{row.bonus}
                {row.failure ? ' (불가)' : ''}
              </option>
            ))}
            <option value="none">현재 장비 판매{sale.failure ? ' (불가)' : ''}</option>
          </select>
        </label>
      </div>
      <p className={styles.muted}>현재 장착: {held?.name ?? '미장착'}</p>
      {item ? (
        <p>
          <strong>
            금 {n(item.cost)} · {EQUIPMENT_STATS[item.stat]} +{item.bonus}
          </strong>
          <br />
          치안 {n(item.requiredSecurity)} 이상 · {materials || '재료 소모 없음'}
          {security === undefined ? null : (
            <>
              <br />
              <span className={security < item.requiredSecurity ? styles.warn : styles.muted}>
                현재 도시 치안 {n(security)}
              </span>
            </>
          )}
        </p>
      ) : null}
      {selling ? <p>현재 장착품 기준 판매 금액: 금 {n(sale.proceeds)}</p> : null}
      {item && held && held.key !== item.key ? (
        <p className={styles.warn} role="note">
          교체하면 기존 장비 금액은 돌려받지 않습니다.
        </p>
      ) : null}
      {/* 지금 상태의 판정과 예약 안내를 붙여 둔다. 30칸 표의 '사전 검사' 열과 같은 말을 쓴다. */}
      {failure ? (
        <p className={styles.warn} role="note">
          사전 검사 경고: {failure.message}
        </p>
      ) : null}
      <p className={styles.muted}>
        매매는 고른 예턴에서 실행합니다. 경고가 있어도 넣을 수 있고 실행할 때 금·재료·도시 조건을 다시 검사합니다.
      </p>
    </div>
  );
}
