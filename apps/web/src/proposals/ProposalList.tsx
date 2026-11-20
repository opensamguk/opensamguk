// 명령 제안(상신) 목록 (D-100, 사용자 2026-11-15 "제안도 넣어.").
// 받은 제안은 권한자(군주와 수뇌)가 칸을 정해 승인하거나 사유를 적어 거절한다. 보낸 제안은 진행 상태를 보고 거둘 수 있다.
// 서버 proposals.list 응답은 contract.ts의 toProposalItem으로 바꿔 넘긴다. 조회와 답하기는 연결하는 쪽(제안함)이 한다.
import { useState } from 'react';
import { Portrait } from '../portrait/Portrait';
import styles from './ProposalList.module.css';

export type ProposalStatus = 'open' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ProposalItem {
  id: string;
  proposer: { id: number; name: string; portraitId: number | null; officerTitle: string | null };
  commandKey: string;
  commandName: string;
  argsSummary: string;
  slot: number | null;
  note: string;
  status: ProposalStatus;
  createdTick: number;
  expiresTick: number;
  precheck: { ok: boolean; message: string } | null;
  response: { by: string; at: number; reason: string | null } | null;
}

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  open: '기다림',
  approved: '승인됨',
  rejected: '거절됨',
  expired: '만료',
  cancelled: '거둠',
};

// 국가 예턴은 직책 12칸이다(T2-06). 화면은 1~12로 보이고 서버에는 0~11로 보낸다(contract.ts).
const SLOT_MAX = 12;

function ReceivedRow({
  item,
  nowTick,
  ticksPerTurn,
  onApprove,
  onReject,
}: {
  item: ProposalItem;
  nowTick: number;
  ticksPerTurn: number;
  onApprove: (id: string, slot: number) => void;
  onReject: (id: string, reason: string) => void;
}) {
  const [slot, setSlot] = useState(item.slot ?? 1);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // 기한은 틱으로 온다. 한 턴(한 달)의 틱 수는 월드 요약에서 받고(gameDate.ts와 같은 식), 남은 일부 턴도 한 턴으로 센다.
  // 턴 길이를 아직 모르면 남은 턴을 적지 않는다.
  const left = ticksPerTurn > 0 ? Math.ceil(Math.max(0, item.expiresTick - nowTick) / ticksPerTurn) : null;
  return (
    <li className={styles.row} data-status={item.status}>
      <div className={styles.who}>
        <Portrait id={item.proposer.portraitId} name={item.proposer.name} variant="icon" shape="round" size={44} />
        <p>
          <b>{item.proposer.name}</b>
          {item.proposer.officerTitle ? <small>{item.proposer.officerTitle}</small> : null}
        </p>
      </div>
      <div className={styles.what}>
        <p className={styles.command}>
          {item.commandName}
          <span>{item.argsSummary}</span>
        </p>
        {item.note ? <p className={styles.note}>“{item.note}”</p> : null}
        {item.precheck && !item.precheck.ok ? (
          <p className={styles.warn} role="note">
            사전 검사 경고: {item.precheck.message}
          </p>
        ) : null}
        <p className={styles.meta}>
          {item.status === 'open'
            ? left === null
              ? STATUS_LABEL.open
              : `${left}턴 뒤 만료`
            : STATUS_LABEL[item.status]}
        </p>
      </div>
      {item.status === 'open' ? (
        <div className={styles.actions}>
          {rejecting ? (
            <>
              <label className={styles.field}>
                <span>거절 사유</span>
                <textarea value={reason} maxLength={200} rows={2} onChange={(event) => setReason(event.target.value)} />
              </label>
              <button type="button" className={styles.danger} onClick={() => onReject(item.id, reason.trim())}>
                거절 보내기
              </button>
              <button type="button" className={styles.secondary} onClick={() => setRejecting(false)}>
                그만두기
              </button>
            </>
          ) : (
            <>
              <label className={styles.field}>
                <span>국가 예턴 칸</span>
                <input
                  type="number"
                  min={1}
                  max={SLOT_MAX}
                  step={1}
                  value={slot}
                  // 칸은 1~12 정수다. 소수는 버리고 범위 밖은 끝 칸으로 맞춘다.
                  onChange={(event) =>
                    setSlot(Math.min(SLOT_MAX, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))
                  }
                />
              </label>
              <button type="button" className={styles.primary} onClick={() => onApprove(item.id, slot)}>
                {slot}번 칸에 승인
              </button>
              <button type="button" className={styles.secondary} onClick={() => setRejecting(true)}>
                거절
              </button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function SentRow({ item, onCancel }: { item: ProposalItem; onCancel: (id: string) => void }) {
  return (
    <li className={styles.row} data-status={item.status}>
      <div className={styles.what}>
        <p className={styles.command}>
          {item.commandName}
          <span>{item.argsSummary}</span>
        </p>
        <p className={styles.meta}>
          {STATUS_LABEL[item.status]}
          {item.response ? `, ${item.response.by}` : ''}
          {item.status === 'approved' && item.slot !== null ? `, ${item.slot}번 칸` : ''}
        </p>
        {item.response?.reason ? <p className={styles.note}>“{item.response.reason}”</p> : null}
      </div>
      {item.status === 'open' ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => onCancel(item.id)}>
            제안 거두기
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ProposalList({
  box,
  items,
  nowTick,
  ticksPerTurn,
  onApprove,
  onReject,
  onCancel,
}: {
  box: 'received' | 'sent';
  items: readonly ProposalItem[];
  nowTick: number;
  // 한 턴의 틱 수. 월드 요약의 turnTermMinutes와 msPerTick에서 나온다. 0이면 남은 턴을 적지 않는다.
  ticksPerTurn: number;
  onApprove?: (id: string, slot: number) => void;
  onReject?: (id: string, reason: string) => void;
  onCancel?: (id: string) => void;
}) {
  const title = box === 'received' ? '받은 명령 제안' : '보낸 명령 제안';
  return (
    <section className={styles.box} aria-label={title}>
      <h2 className={styles.title}>{title}</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>{box === 'received' ? '받은 제안이 없습니다.' : '보낸 제안이 없습니다.'}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) =>
            box === 'received' ? (
              <ReceivedRow
                key={item.id}
                item={item}
                nowTick={nowTick}
                ticksPerTurn={ticksPerTurn}
                onApprove={onApprove ?? (() => {})}
                onReject={onReject ?? (() => {})}
              />
            ) : (
              <SentRow key={item.id} item={item} onCancel={onCancel ?? (() => {})} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
