import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { formatYearMonth } from '../game/gameDate';
import { retryUnlessClientError } from '../game/errors';
import { DisabledReason } from '../ui/DisabledReason';
import { Tag } from '../ui/Tag';
import {
  buildClauses,
  canChoosePeace,
  CLAUSE_LABELS,
  emptyCompose,
  isEnforced,
  type ComposeState,
  type Side,
} from './clauses';
import {
  NON_AGGRESSION_MONTHS,
  NOTE_MAX_LENGTH,
  PROPOSAL_EXPIRES_MONTHS,
  treatyApi,
  treatyQueryKey,
  type ClauseKind,
  type ProposeInput,
  type Relation,
  type TreatyTarget,
} from './contract';
import styles from './Diplomacy.module.css';
import { trustText } from './TreatyCard';

export const RELATION_TEXT: Record<Relation, string> = {
  WAR: '교전',
  DECLARED: '선포',
  NON_AGGRESSION: '불가침',
  NONE: '관계 없음',
};

export const relationText = (target: TreatyTarget) =>
  target.relationEndAt
    ? `${RELATION_TEXT[target.relation]} (${formatYearMonth(target.relationEndAt)}까지)`
    : RELATION_TEXT[target.relation];

interface City {
  key: number;
  name: string;
  nationId: number | null;
}

interface Props {
  worldId: string;
  myNationId: number;
  targets: TreatyTarget[];
  cities: City[];
  // 이 상대에게 보낸 제안이 처리 중이면 그 안내. 있으면 보내기를 잠근다.
  busyFor: (toNationId: number) => string | null;
  onPropose: (input: ProposeInput) => void;
}

// 조약서 쓰기. 조항을 고르면 비용과 서버가 집행하는 것·기록만 남는 것을 바로 보여 준다 (T2-08 화면 절).
export function TreatyComposer({ worldId, myNationId, targets, cities, busyFor, onPropose }: Props) {
  const [form, setForm] = useState<ComposeState>(emptyCompose);
  const ids = { target: useId(), note: useId() };
  const target = targets.find((t) => t.nation.id === form.toNationId);
  const built = buildClauses(form, myNationId, target?.relation);
  const myCities = useMemo(
    () => cities.filter((c) => c.nationId === myNationId).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [cities, myNationId],
  );
  const theirCities = useMemo(
    () =>
      cities
        .filter((c) => c.nationId !== null && c.nationId === form.toNationId)
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [cities, form.toNationId],
  );

  // 비용과 조항별 문제는 서버가 계산한다. 저장하지 않는 조회라 쓰는 동안 바로 다시 묻는다.
  const quoteInput =
    form.toNationId !== null && built.clauses.length > 0
      ? { worldId, toNationId: form.toNationId, clauses: built.clauses }
      : null;
  const quote = useQuery({
    queryKey: treatyQueryKey('quote', quoteInput ?? {}),
    queryFn: () => treatyApi.quote.query(quoteInput!),
    enabled: quoteInput !== null,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
  const quoteProblems = quoteInput !== null ? (quote.data?.problems ?? []) : [];
  const problemFor = (kind: ClauseKind) => {
    const index = built.clauses.findIndex((c) => c.kind === kind);
    return index < 0 ? [] : quoteProblems.filter((p) => p.index === index).map((p) => p.reason);
  };

  const set = <K extends keyof ComposeState>(key: K, value: ComposeState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const busy = form.toNationId !== null ? busyFor(form.toNationId) : null;
  const blocked =
    busy ?? built.problems[0] ?? (quoteProblems.length > 0 ? '서버가 알려 준 조항 문제를 먼저 고치세요.' : null);

  const submit = () => {
    if (blocked !== null || form.toNationId === null) return;
    onPropose({ toNationId: form.toNationId, clauses: built.clauses, expiresInMonths: PROPOSAL_EXPIRES_MONTHS });
  };

  const peaceOk = canChoosePeace(target?.relation);
  const enforcedKinds = built.clauses.filter((c) => isEnforced(c.kind)).map((c) => CLAUSE_LABELS[c.kind]);
  const recordKinds = built.clauses.filter((c) => !isEnforced(c.kind)).map((c) => CLAUSE_LABELS[c.kind]);

  return (
    <form
      className={styles.composer}
      aria-label="조약서 쓰기"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.row}>
        <label htmlFor={ids.target}>상대</label>
        <select
          id={ids.target}
          value={form.toNationId ?? ''}
          onChange={(e) => {
            const id = e.target.value === '' ? null : Number(e.target.value);
            // 상대가 바뀌면 상대 도시를 고른 조항은 비운다.
            setForm((prev) => ({
              ...prev,
              toNationId: id,
              peace: false,
              cityTransfer: {
                ...prev.cityTransfer,
                cityKey: prev.cityTransfer.giver === 'them' ? null : prev.cityTransfer.cityKey,
              },
            }));
          }}
        >
          <option value="">고르세요</option>
          {targets.map((t) => (
            <option key={t.nation.id} value={t.nation.id}>
              {t.nation.name}
            </option>
          ))}
        </select>
        {target ? (
          <span className={styles.muted} data-testid="target-relation">
            {relationText(target)} · 신의 {trustText(target.trust)}
          </span>
        ) : null}
      </div>

      <fieldset className={styles.clauseBox}>
        <legend>조항</legend>

        <ClauseRow
          label={CLAUSE_LABELS.peace}
          checked={form.peace && peaceOk}
          disabledReason={peaceOk ? null : '종전은 교전 중이거나 선포한 상대에게만 제안합니다.'}
          onToggle={(on) => set('peace', on)}
          problems={problemFor('peace')}
        />

        <ClauseRow
          label={CLAUSE_LABELS.nonAggression}
          checked={form.nonAggression.on}
          onToggle={(on) => set('nonAggression', { ...form.nonAggression, on })}
          problems={problemFor('nonAggression')}
        >
          <NumberField
            label="기간(개월)"
            value={form.nonAggression.months}
            min={NON_AGGRESSION_MONTHS.min}
            max={NON_AGGRESSION_MONTHS.max}
            onChange={(months) => set('nonAggression', { ...form.nonAggression, months })}
          />
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.passage}
          checked={form.passage.on}
          onToggle={(on) => set('passage', { ...form.passage, on })}
          problems={problemFor('passage')}
        >
          <label className={styles.inline}>
            <span>상대 장수가 지나갈 우리 도시</span>
            <select
              multiple
              size={Math.min(6, Math.max(2, myCities.length))}
              value={form.passage.cityKeys.map(String)}
              onChange={(e) =>
                set('passage', { ...form.passage, cityKeys: [...e.target.selectedOptions].map((o) => Number(o.value)) })
              }
            >
              {myCities.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.tribute}
          checked={form.tribute.on}
          onToggle={(on) => set('tribute', { ...form.tribute, on })}
          problems={problemFor('tribute')}
        >
          <SideField
            label="내는 쪽"
            value={form.tribute.payer}
            theirName={target?.nation.name}
            onChange={(payer) => set('tribute', { ...form.tribute, payer })}
          />
          <NumberField
            label="매월 금"
            value={form.tribute.gold}
            min={0}
            onChange={(gold) => set('tribute', { ...form.tribute, gold })}
          />
          <NumberField
            label="매월 쌀"
            value={form.tribute.rice}
            min={0}
            onChange={(rice) => set('tribute', { ...form.tribute, rice })}
          />
          <NumberField
            label="기간(개월)"
            value={form.tribute.months}
            min={1}
            onChange={(months) => set('tribute', { ...form.tribute, months })}
          />
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.trade}
          checked={form.trade.on}
          onToggle={(on) => set('trade', { ...form.trade, on })}
          problems={problemFor('trade')}
        >
          <NumberField
            label="기간(개월)"
            value={form.trade.months}
            min={1}
            onChange={(months) => set('trade', { ...form.trade, months })}
          />
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.cityTransfer}
          checked={form.cityTransfer.on}
          onToggle={(on) => set('cityTransfer', { ...form.cityTransfer, on })}
          problems={problemFor('cityTransfer')}
        >
          <SideField
            label="넘기는 쪽"
            value={form.cityTransfer.giver}
            theirName={target?.nation.name}
            onChange={(giver) => set('cityTransfer', { ...form.cityTransfer, giver, cityKey: null })}
          />
          <label className={styles.inline}>
            <span>도시</span>
            <select
              value={form.cityTransfer.cityKey ?? ''}
              onChange={(e) =>
                set('cityTransfer', {
                  ...form.cityTransfer,
                  cityKey: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            >
              <option value="">고르세요</option>
              {(form.cityTransfer.giver === 'us' ? myCities : theirCities).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.note}
          checked={form.note.on}
          onToggle={(on) => set('note', { ...form.note, on })}
          problems={problemFor('note')}
        >
          <label className={styles.inline} htmlFor={ids.note}>
            <span>
              문장 ({form.note.text.length}/{NOTE_MAX_LENGTH}자)
            </span>
          </label>
          <textarea
            id={ids.note}
            className={styles.note}
            maxLength={NOTE_MAX_LENGTH}
            rows={2}
            value={form.note.text}
            onChange={(e) => set('note', { ...form.note, text: e.target.value })}
          />
        </ClauseRow>
      </fieldset>

      <section className={styles.summary} aria-label="조약서 요약" aria-live="polite">
        <p>
          <Tag tone="accent">집행</Tag> 서버가 집행하는 조항:{' '}
          {enforcedKinds.length > 0 ? enforcedKinds.join(', ') : '없음'}
        </p>
        <p>
          <Tag tone="muted">기록</Tag> 기록만 남는 조항: {recordKinds.length > 0 ? recordKinds.join(', ') : '없음'}
        </p>
        <p className="num" data-testid="treaty-cost">
          {quoteInput === null
            ? '비용은 상대와 조항을 고르면 나옵니다.'
            : quote.data
              ? `비용 우리 금 ${quote.data.cost.mine.toLocaleString('ko-KR')} · 상대 금 ${quote.data.cost.theirs.toLocaleString('ko-KR')} (양쪽이 수락 때 냅니다)`
              : quote.isError
                ? '비용을 계산하지 못했습니다. 보내면 서버가 다시 계산합니다.'
                : '비용 계산 중'}
        </p>
        <p className={styles.muted}>
          제안 기한은 {PROPOSAL_EXPIRES_MONTHS}개월입니다. 상대가 그 안에 답하지 않으면 끝납니다.
        </p>
      </section>

      <div className={styles.buttons}>
        {blocked === null ? (
          <button type="submit" className={styles.primary}>
            제안 보내기
          </button>
        ) : (
          <DisabledReason reason={blocked}>제안 보내기</DisabledReason>
        )}
      </div>
    </form>
  );
}

function ClauseRow({
  label,
  checked,
  disabledReason,
  onToggle,
  problems,
  children,
}: {
  label: string;
  checked: boolean;
  disabledReason?: string | null;
  onToggle: (on: boolean) => void;
  problems: string[];
  children?: ReactNode;
}) {
  return (
    <div className={styles.clauseRow} data-clause={label}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!!disabledReason}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {label}
      </label>
      {disabledReason ? <span className={styles.muted}>{disabledReason}</span> : null}
      {checked && children ? <div className={styles.clauseFields}>{children}</div> : null}
      {checked && problems.length > 0 ? (
        <p className={styles.problem} role="alert">
          {problems.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.inline}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        className="num"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SideField({
  label,
  value,
  theirName,
  onChange,
}: {
  label: string;
  value: Side;
  theirName: string | undefined;
  onChange: (value: Side) => void;
}) {
  return (
    <label className={styles.inline}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Side)}>
        <option value="us">우리</option>
        <option value="them">{theirName ?? '상대'}</option>
      </select>
    </label>
  );
}
