import { useState } from 'react';
import { formatYearMonth } from '../game/gameDate';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { Tag, type TagTone } from '../ui/Tag';
import { describeClause, isEnforced } from './clauses';
import type { Allowed, NationRef, TreatyItem, TreatyStatus } from './contract';
import styles from './Diplomacy.module.css';

export const STATUS_LABELS: Record<TreatyStatus, { text: string; tone: TagTone }> = {
  PROPOSED: { text: '제안됨', tone: 'info' },
  ACTIVE: { text: '진행 중', tone: 'accent' },
  ENDED: { text: '끝남', tone: 'muted' },
  REJECTED: { text: '거절됨', tone: 'muted' },
  EXPIRED: { text: '기한 지남', tone: 'muted' },
  BROKEN: { text: '파기됨', tone: 'danger' },
};

// 당사국 행이 없으면(멸망) 서버는 null을 준다. 이름을 지어내지 않고 ID와 함께 없는 국가라고 적는다.
export const nationName = (nation: NationRef | null, id: number) => nation?.name ?? `없는 국가 (ID ${id})`;

function Party({ nation, id }: { nation: NationRef | null; id: number }) {
  if (nation) return <NationBadge name={nation.name} color={nation.color} />;
  return (
    <span className={styles.muted} data-missing-nation={id}>
      {nationName(null, id)}
    </span>
  );
}

const gold = (value: number) => value.toLocaleString('ko-KR');

// 제안 중 비용은 지금 도시 수로 낸 추정이다. 수락 때 엔진이 다시 계산한다.
export const estimateText = (estimate: TreatyItem['estimate']) =>
  estimate === null
    ? '당사국이 없어 계산하지 않습니다.'
    : `우리 금 ${gold(estimate.mine)} · 상대 금 ${gold(estimate.theirs)} (지금 도시 수 기준, 수락 때 다시 계산)`;

// 맺은 뒤 실제로 낸 금액. 어느 국가가 얼마를 냈는지 당사국 이름으로 적는다.
export function paidText(treaty: TreatyItem, cost: NonNullable<TreatyItem['cost']>): string {
  const from = `${nationName(treaty.from, treaty.fromNationId)} 금 ${gold(cost.from)}`;
  const to = `${nationName(treaty.to, treaty.toNationId)} 금 ${gold(cost.to)}`;
  return `${from} · ${to}`;
}

interface Props {
  treaty: TreatyItem;
  // 이 조약에 결과를 기다리는 요청이 있으면 그 안내. 있으면 단추를 잠근다.
  busy: string | null;
  onRespond: (accept: boolean) => void;
  onBreak?: () => void;
}

// 단추 하나. 서버가 준 Allowed만 본다. 권한이 없으면(NO_PERMISSION) 읽기만 하도록 단추를 그리지 않는다.
// 다른 이유는 점선 단추로 두고 누르면 서버가 준 문장을 그대로 보여 준다. 사유 문장으로 분기하지 않는다.
function ActionButton({
  allowed,
  busy,
  label,
  onClick,
}: {
  allowed: Allowed | null;
  busy: string | null;
  label: string;
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
    <button type="button" className={styles.primary} onClick={onClick}>
      {label}
    </button>
  );
}

// 비용 줄. 제안 중이면 지금 도시 수로 낸 추정(estimate)이다. 맺은 뒤에는 실제로 낸 금액(cost)이다. 둘을 섞지 않는다.
// 상대 국고로 낼 수 있는지는 서버가 알려 주지 않으므로 화면도 판단하지 않는다.
function CostFact({ treaty }: { treaty: TreatyItem }) {
  if (treaty.status === 'PROPOSED')
    return (
      <div>
        <dt>예상 수락 비용</dt>
        <dd className="num" data-testid="treaty-estimate">
          {estimateText(treaty.estimate)}
        </dd>
      </div>
    );
  if (treaty.cost === null) return null;
  return (
    <div>
      <dt>낸 비용</dt>
      <dd className="num" data-testid="treaty-cost-paid">
        {paidText(treaty, treaty.cost)}
      </dd>
    </div>
  );
}

export function TreatyCard({ treaty, busy, onRespond, onBreak }: Props) {
  const [confirmBreak, setConfirmBreak] = useState(false);
  const status = STATUS_LABELS[treaty.status];
  const enforced = treaty.clauses.filter((c) => isEnforced(c.kind));
  const recorded = treaty.clauses.filter((c) => !isEnforced(c.kind));
  const answers = [treaty.canAccept, treaty.canReject];
  const readOnly =
    answers.some((a) => a !== null) && answers.every((a) => a === null || (!a.ok && a.code === 'NO_PERMISSION'));

  return (
    <article
      className={styles.card}
      data-testid="treaty-card"
      data-treaty-id={treaty.id}
      aria-label={`${nationName(treaty.from, treaty.fromNationId)}와 ${nationName(treaty.to, treaty.toNationId)}의 조약`}
    >
      <header className={styles.cardHead}>
        <Party nation={treaty.from} id={treaty.fromNationId} />
        <span aria-hidden="true">→</span>
        <Party nation={treaty.to} id={treaty.toNationId} />
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
            <dd>{formatYearMonth(treaty.endAt)}</dd>
          </div>
        ) : null}
        <CostFact treaty={treaty} />
      </dl>

      {enforced.length > 0 ? (
        <section aria-label="서버가 집행하는 조항">
          <h4 className={styles.clauseHead}>서버가 집행하는 조항</h4>
          <ul className={styles.clauses}>
            {enforced.map((clause, i) => (
              <li key={i}>{describeClause(clause)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {recorded.length > 0 ? (
        <section aria-label="기록만 남는 조항">
          <h4 className={styles.clauseHead}>기록만 남는 조항</h4>
          <ul className={styles.clauses}>
            {recorded.map((clause, i) => (
              <li key={i}>{describeClause(clause)}</li>
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
        {onBreak && treaty.status === 'ACTIVE' ? (
          <ActionButton
            allowed={treaty.canBreak ?? null}
            busy={busy}
            label="파기"
            onClick={() => setConfirmBreak(true)}
          />
        ) : null}
      </div>
      {confirmBreak && onBreak && treaty.status === 'ACTIVE' ? (
        <div role="group" aria-label="조약 파기 확인">
          <p>파기하면 신의 기록이 1회 늘어 모든 국가에 보입니다.</p>
          <ActionButton allowed={treaty.canBreak ?? null} busy={busy} label="파기 확정" onClick={onBreak} />
          <button type="button" onClick={() => setConfirmBreak(false)}>
            취소
          </button>
        </div>
      ) : null}
    </article>
  );
}
