import { useState } from 'react';
import { formatYearMonth } from '../game/gameDate';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { Tag, type TagTone } from '../ui/Tag';
import { describeClause, type ClauseNames } from './clauses';
import type { Allowed, TreatyRow, TreatyStatus, TrustRow } from './contract';
import styles from './Diplomacy.module.css';

export const STATUS_LABELS: Record<TreatyStatus, { text: string; tone: TagTone }> = {
  PROPOSED: { text: '제안됨', tone: 'info' },
  ACTIVE: { text: '진행 중', tone: 'accent' },
  ENDED: { text: '끝남', tone: 'muted' },
  REJECTED: { text: '거절됨', tone: 'muted' },
  EXPIRED: { text: '기한 지남', tone: 'muted' },
  BROKEN: { text: '파기됨', tone: 'danger' },
};

export const trustText = (trust: TrustRow) =>
  trust.brokenTreaties === 0
    ? '파기 기록 없음'
    : `파기 ${trust.brokenTreaties}회 (마지막 ${formatYearMonth(trust.lastBrokenAt)})`;

interface Props {
  treaty: TreatyRow;
  names: ClauseNames;
  // 이 조약에 결과를 기다리는 요청이 있으면 그 안내. 있으면 단추를 잠근다.
  busy: string | null;
  onRespond: (accept: boolean) => void;
  onBreak: () => void;
}

// 단추 하나. 서버가 준 Allowed만 본다. 권한이 없으면(NO_PERMISSION) 읽기만 하도록 단추를 그리지 않는다.
// 다른 이유는 점선 단추로 두고 누르면 이유를 보여 준다. 사유 문장으로 분기하지 않는다.
function ActionButton({
  allowed,
  busy,
  label,
  danger,
  onClick,
}: {
  allowed: Allowed | null;
  busy: string | null;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  if (allowed === null) return null;
  if (!allowed.ok && allowed.code === 'NO_PERMISSION') return null;
  if (busy !== null)
    return (
      <DisabledReason reason="처리 중인 요청이 있습니다. 결과가 나오면 다시 고를 수 있습니다.">{label}</DisabledReason>
    );
  if (!allowed.ok) return <DisabledReason reason={allowed.reason}>{label}</DisabledReason>;
  return (
    <button type="button" className={danger ? styles.danger : styles.primary} onClick={onClick}>
      {label}
    </button>
  );
}

export function TreatyCard({ treaty, names, busy, onRespond, onBreak }: Props) {
  const [confirming, setConfirming] = useState(false);
  const status = STATUS_LABELS[treaty.status];
  const counterpart = treaty.incoming ? treaty.from : treaty.to;
  const enforced = treaty.clauses.filter((c) => c.enforced);
  const recorded = treaty.clauses.filter((c) => !c.enforced);
  const readOnly =
    [treaty.canAccept, treaty.canReject, treaty.canBreak].every(
      (a) => a === null || (!a.ok && a.code === 'NO_PERMISSION'),
    ) && [treaty.canAccept, treaty.canReject, treaty.canBreak].some((a) => a !== null);

  return (
    <article
      className={styles.card}
      data-testid="treaty-card"
      data-treaty-id={treaty.id}
      aria-label={`${treaty.from.name}와 ${treaty.to.name}의 조약`}
    >
      <header className={styles.cardHead}>
        <NationBadge name={treaty.from.name} color={treaty.from.color} />
        <span aria-hidden="true">→</span>
        <NationBadge name={treaty.to.name} color={treaty.to.color} />
        <Tag tone={status.tone}>{status.text}</Tag>
        {busy !== null ? <Tag tone="warning">처리 중</Tag> : null}
      </header>

      <dl className={styles.facts}>
        <div>
          <dt>제안</dt>
          <dd>{formatYearMonth(treaty.proposedAt)}</dd>
        </div>
        {treaty.respondBy ? (
          <div>
            <dt>응답 기한</dt>
            <dd>{formatYearMonth(treaty.respondBy)}</dd>
          </div>
        ) : null}
        {treaty.startAt ? (
          <div>
            <dt>시작</dt>
            <dd>{formatYearMonth(treaty.startAt)}</dd>
          </div>
        ) : null}
        {treaty.endAt ? (
          <div>
            <dt>끝</dt>
            <dd>
              {formatYearMonth(treaty.endAt)}
              {treaty.monthsLeft !== null ? ` (${treaty.monthsLeft}개월 남음)` : null}
            </dd>
          </div>
        ) : null}
        {treaty.brokenBy ? (
          <div>
            <dt>파기한 국가</dt>
            <dd>{treaty.brokenBy.name}</dd>
          </div>
        ) : null}
        {treaty.status === 'PROPOSED' ? (
          <div>
            <dt>수락 비용</dt>
            <dd className="num">
              우리 금 {treaty.cost.mine.toLocaleString('ko-KR')} · 상대 금 {treaty.cost.theirs.toLocaleString('ko-KR')}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{counterpart.name}의 신의</dt>
          <dd>{trustText(treaty.counterpartTrust)}</dd>
        </div>
      </dl>

      {enforced.length > 0 ? (
        <section aria-label="서버가 집행하는 조항">
          <h4 className={styles.clauseHead}>서버가 집행하는 조항</h4>
          <ul className={styles.clauses}>
            {enforced.map((clause, i) => (
              <li key={i}>{describeClause(clause, names)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {recorded.length > 0 ? (
        <section aria-label="기록만 남는 조항">
          <h4 className={styles.clauseHead}>기록만 남는 조항</h4>
          <ul className={styles.clauses}>
            {recorded.map((clause, i) => (
              <li key={i}>{describeClause(clause, names)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {busy !== null ? (
        <p className={styles.busy} role="status">
          {busy}
        </p>
      ) : null}
      {readOnly ? <p className={styles.muted}>외교 문서는 군주와 참모가 답합니다. 이 직책은 읽기만 합니다.</p> : null}

      <div className={styles.buttons}>
        <ActionButton allowed={treaty.canAccept} busy={busy} label="수락" onClick={() => onRespond(true)} />
        <ActionButton allowed={treaty.canReject} busy={busy} label="거절" onClick={() => onRespond(false)} />
        {confirming ? null : (
          <ActionButton allowed={treaty.canBreak} busy={busy} label="파기" danger onClick={() => setConfirming(true)} />
        )}
      </div>
      {confirming ? (
        <div className={styles.confirm} role="alertdialog" aria-label="파기 확인">
          <p>파기하면 신의 기록에 남습니다. 다른 국가도 이 기록을 봅니다.</p>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.danger}
              onClick={() => {
                setConfirming(false);
                onBreak();
              }}
            >
              파기 확정
            </button>
            <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>
              취소
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
