// 성 밖 자리 창과 건설 고르기(D-106, D-107). 빈 터는 지을 수 있는 건물을, 지은 자리는 건물과 철거를 보인다.
// 비용, 기간, 막힌 이유는 서버 home.get의 land 값을 그대로 쓴다. 고른 명령은 예턴 초안에 넣고 저장은 예턴 편집기에서 한다.
import { useEffect, useState } from 'react';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { buildingName, facilityIcon, type CityLand } from './CityScene';
import styles from './LotWindow.module.css';

export type LandTurn =
  | { commandKey: 'build'; args: { slotId: string; building: string } }
  | { commandKey: 'demolish'; args: { slotId: string } };
/** 예턴에 넣은 결과. ok면 넣은 칸 번호(0부터), 아니면 넣지 못한 이유. */
export type ReserveResult = { ok: true; slot: number } | { ok: false; message: string };
export type Reserve = (turn: LandTurn) => ReserveResult;

/**
 * 예턴 초안의 첫 빈 칸(비워 둔 칸)에 건설이나 철거를 넣는다. 저장은 하지 않는다(작전 맞추기와 같은 edit 경로).
 * 저장은 예턴 편집기의 [저장]으로 하고, 비용과 조건은 서버가 다시 검사한다.
 */
export function reserveInDraft(draft: TurnDraftState | null, turn: LandTurn): ReserveResult {
  if (!draft?.turns) return { ok: false, message: '예턴을 불러온 뒤에 넣으세요.' };
  if (draft.pending) return { ok: false, message: '먼저 예턴 충돌 안내에서 다시 적용할지 고르세요.' };
  if (draft.saving) return { ok: false, message: '저장하는 중입니다.' };
  const index = draft.turns.findIndex((entry) => !entry.explicit);
  if (index < 0) return { ok: false, message: '예턴에 빈 칸이 없습니다.' };
  draft.edit({
    put: { indices: [index], turn: { commandKey: turn.commandKey, args: { ...turn.args }, explicit: true } },
  });
  return { ok: true, slot: index };
}

/** 예턴 편집기의 renderTop 안에 두어 같은 초안 상태를 바깥(성 화면)에 건넨다. 그리는 것은 없다. */
export function DraftBridge({ draft, target }: { draft: TurnDraftState; target: { current: TurnDraftState | null } }) {
  useEffect(() => {
    target.current = draft;
    return () => {
      target.current = null;
    };
  }, [draft, target]);
  return null;
}

/** 한 자리에서 할 수 있는 건설과 철거. 성 안 창과 성 밖 자리 창이 같이 쓴다. */
export function LotPicker({
  land,
  slotId,
  onReserve,
  layout = 'list',
}: {
  land: CityLand;
  slotId: string;
  /** 없으면 예턴에 넣기를 막는다. */
  onReserve?: Reserve | undefined;
  layout?: 'list' | 'cards';
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [result, setResult] = useState<ReserveResult | null>(null);
  const slot = land.slots.find((entry) => entry.id === slotId);
  if (!slot) return <p className={styles.note}>없는 자리입니다.</p>;
  const reserve = (turn: LandTurn) => {
    if (onReserve) setResult(onReserve(turn));
  };
  const status = result ? (
    <p className={styles.status} role="status" data-ok={result.ok ? 'true' : 'false'}>
      {result.ok ? `예턴 ${result.slot + 1}번 칸에 넣었습니다. 예턴에서 저장하세요.` : result.message}
    </p>
  ) : null;

  const row = slot.building;
  if (row) {
    const url = facilityIcon(row.building);
    return (
      <div className={styles.built} data-testid="lot-built">
        <div className={styles.builtHead}>
          {url ? <img src={url} alt="" className={styles.icon} /> : null}
          <b>{buildingName(land, row.building)}</b>
          {row.remainingTurns > 0 ? <span className={styles.meta}>공사 중, {row.remainingTurns}달 남음</span> : null}
        </div>
        <button
          type="button"
          className="kit-button"
          data-kind="secondary"
          disabled={!onReserve}
          onClick={() => reserve({ commandKey: 'demolish', args: { slotId } })}
        >
          철거 예턴에 넣기
        </button>
        <p className={styles.note}>철거하면 자원은 돌려받지 못합니다.</p>
        {status}
      </div>
    );
  }

  const specs = land.buildings.filter((spec) => spec.zone === slot.zone);
  const failureOf = (key: string) =>
    specs.find((spec) => spec.key === key)?.slots.find((entry) => entry.slotId === slotId)?.failure ?? null;
  const picked = choice && !failureOf(choice) ? choice : null;
  return (
    <div className={styles.picker}>
      <ul
        className={styles.list}
        data-layout={layout}
        aria-label={slot.zone === 'inside' ? '성 안에 지을 수 있는 건물' : '성 밖에 지을 수 있는 건물'}
      >
        {specs.map((spec) => {
          const failure = failureOf(spec.key);
          const url = facilityIcon(spec.key);
          return (
            <li key={spec.key} className={styles.item} data-blocked={failure ? 'true' : undefined}>
              <button
                type="button"
                className={`kit-card ${styles.pick}`}
                aria-pressed={picked === spec.key}
                disabled={Boolean(failure)}
                onClick={() => {
                  setChoice(spec.key);
                  setResult(null);
                }}
              >
                {url ? <img src={url} alt="" className={styles.icon} /> : null}
                <b>{spec.name}</b>
                <span className={styles.meta}>
                  금 {spec.gold}, 목재 {spec.wood}, {spec.turns}달
                </span>
                {failure ? (
                  <span className={styles.blocked}>{failure.message}</span>
                ) : spec.unique ? (
                  <span className={styles.meta}>도시당 1</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.foot}>
        <button
          type="button"
          className="kit-button"
          disabled={!onReserve || !picked}
          onClick={() => picked && reserve({ commandKey: 'build', args: { slotId, building: picked } })}
        >
          예턴에 넣기
        </button>
        {status}
      </div>
    </div>
  );
}

/** 성 밖 자리 창. */
export function LotWindow({
  land,
  slotId,
  onReserve,
  onClose,
}: {
  land: CityLand;
  slotId: string;
  onReserve?: Reserve | undefined;
  onClose: () => void;
}) {
  const slot = land.slots.find((entry) => entry.id === slotId);
  const title = slot?.building ? buildingName(land, slot.building.building) : '빈 터';
  return (
    <section className={`kit-window ${styles.window}`} aria-labelledby="lot-title" data-testid="lot-window">
      <header className={styles.head}>
        <h2 id="lot-title" className={`kit-title ${styles.title}`}>
          성 밖 {title}
        </h2>
        <button type="button" className="kit-button" data-kind="secondary" onClick={onClose}>
          닫기
        </button>
      </header>
      {/* 자리가 바뀌면 고른 건물과 결과를 비운다. */}
      <LotPicker key={slotId} land={land} slotId={slotId} onReserve={onReserve} />
    </section>
  );
}
