import { useId, useState } from 'react';
import {
  formatCount,
  GOOD_LABEL,
  LOGISTICS_GOODS,
  type LogisticsGood,
  type OwnLogisticsBoard,
} from '../queries/logistics';
import { recruitPreview, RECRUIT_PREVIEW_MAX, shortGoods } from './costPreview';
import styles from './logistics.module.css';

// 모병·투자 재화 비용 (T4-93). 비용만 미리 보며 명령을 넣거나 실행하지 않는다. 명령은 예턴에서 넣는다.
// 입력은 이 칸 안에만 두어 일반 재조회로 board가 바뀌어도 지워지지 않는다.
const goodsText = (goods: Record<LogisticsGood, number>) =>
  LOGISTICS_GOODS.filter(([good]) => goods[good] > 0)
    .map(([good, label]) => `${label} ${formatCount(goods[good])}`)
    .join(' · ') || '없음';

function Short({ items, subject }: { items: ReturnType<typeof shortGoods>; subject: string }) {
  if (!items.length) return null;
  return (
    <p className={styles.warning} role="note">
      지금 재고로는 {items.map(({ good, missing }) => `${GOOD_LABEL[good]} ${formatCount(missing)}`).join(' · ')}이
      모자랍니다. 예약은 할 수 있지만 처리될 때도 모자라면 {subject} 실패합니다.
    </p>
  );
}

export function LogisticsCosts({ board }: { board: OwnLogisticsBoard }) {
  const [unit, setUnit] = useState('');
  const [people, setPeople] = useState('');
  const id = useId();
  const preview = recruitPreview(board, unit, people);
  const { wall, defence } = board.costs.build;
  return (
    <details className={styles.costs}>
      <summary>모병·투자 재화 비용</summary>
      <div className={styles.costBody}>
        <p className={styles.note}>
          모병·징병과 성벽·수비 투자는 이 도시의 철·목재·말을 씁니다. 이 칸은 비용만 미리 보며 명령을 넣지 않습니다.
          명령은 예턴에서 넣습니다.
        </p>
        {board.recruitUnits.length ? (
          <div className={styles.form}>
            <div className={styles.goods}>
              <label>
                병종
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="">병종을 고르세요</option>
                  {board.recruitUnits.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                모집 인원 (1~{formatCount(RECRUIT_PREVIEW_MAX)})
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={RECRUIT_PREVIEW_MAX}
                  step={1}
                  value={people}
                  aria-describedby={`${id}-rule`}
                  onChange={(e) => setPeople(e.target.value)}
                />
              </label>
            </div>
            {preview.kind === 'invalid' ? (
              <p className={styles.warning} role="note">
                모집 인원은 1부터 {formatCount(RECRUIT_PREVIEW_MAX)}까지의 정수로 넣으세요.
              </p>
            ) : preview.kind === 'unknown' ? (
              <p className={styles.warning} role="note">
                이 병종의 재화 비용 정보가 없습니다.
              </p>
            ) : preview.kind === 'ready' ? (
              <>
                <dl className={styles.preview} aria-label="모병 예상 소비">
                  <dt>100명당</dt>
                  <dd>{goodsText(preview.per100)}</dd>
                  <dt>예상 소비</dt>
                  <dd>{goodsText(preview.cost)}</dd>
                </dl>
                <Short items={preview.short} subject="그 명령은" />
              </>
            ) : null}
            <p id={`${id}-rule`} className={styles.note}>
              100명 단위로 올려 계산합니다. 명령이 처리될 때의 모집 인원과 그때 도시 재고로 다시 판정합니다.
            </p>
          </div>
        ) : (
          <p className={styles.note}>이 월드에는 모집할 수 있는 병종이 없습니다.</p>
        )}
        <dl className={styles.preview} aria-label="투자 1회 성공 때 비용">
          <dt>성벽 투자 1회</dt>
          <dd>{goodsText(wall)}</dd>
          <dt>수비 투자 1회</dt>
          <dd>{goodsText(defence)}</dd>
        </dl>
        <Short items={shortGoods(board.resources, wall)} subject="성벽 투자는" />
        <Short items={shortGoods(board.resources, defence)} subject="수비 투자는" />
        <p className={styles.note}>
          투자 비용은 투자가 성공할 때만 빠집니다. 처리될 때 그때 도시 재고로 다시 판정합니다.
        </p>
      </div>
    </details>
  );
}
