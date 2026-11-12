import { skipToken, useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { formatYearMonth } from '../game/gameDate';
import { retryUnlessClientError } from '../game/errors';
import type { WorldMap } from '../game/types';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { Tag } from '../ui/Tag';
import {
  buildClauses,
  canChoosePeace,
  clauseCities,
  CLAUSE_LABELS,
  describeClause,
  emptyCompose,
  emptyExpandedClauses,
  isEnforced,
  noteLength,
  TREATY_MAX_MONTHS,
  TRIBUTE_MAX_AMOUNT,
  UNSUPPORTED_CLAUSE_LABELS,
  UNSUPPORTED_CLAUSE_REASON,
  type ComposeState,
} from './clauses';
import {
  NON_AGGRESSION_MONTHS,
  NOTE_MAX_LENGTH,
  PROPOSAL_RESPONSE_MONTHS,
  type ProposeInput,
  type Quote,
  type Relation,
  type TreatyTarget,
} from './contract';
import styles from './Diplomacy.module.css';

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

const gold = (value: number) => value.toLocaleString('ko-KR');

// 견적 비용은 지금 도시 수로 낸 추정이다. 상대 국고로 낼 수 있는지는 서버가 알려 주지 않으므로 적지 않는다.
export const quoteCostText = (cost: NonNullable<Quote['cost']>) =>
  `예상 비용 우리 금 ${gold(cost.mine)} · 상대 금 ${gold(cost.theirs)} (지금 도시 수 기준, 수락되면 양쪽이 냅니다)`;

function costText(asked: boolean, data: Quote | undefined, failed: boolean): string {
  if (!asked) return '비용은 상대와 조항을 고르면 나옵니다.';
  if (data) return data.cost ? quoteCostText(data.cost) : '서버가 비용을 계산하지 않았습니다.';
  return failed ? '비용을 계산하지 못했습니다. 보내면 서버가 다시 판단합니다.' : '비용 계산 중';
}

interface Props {
  worldId: string;
  targets: TreatyTarget[];
  tradeEnabled?: boolean;
  expandedEnabled?: boolean;
  ownNationId: number;
  map: WorldMap | undefined;
  // 이 상대에게 보낸 제안이 처리 중이면 그 안내. 있으면 보내기를 잠근다.
  busyFor: (toNationId: number) => string | null;
  onPropose: (input: ProposeInput) => void;
}

// 조약서 쓰기. 조항을 고르면 서버 견적의 비용과 문제, 집행·기록 구분을 바로 보여 준다 (T2-08 화면 절).
export function TreatyComposer({
  worldId,
  targets,
  busyFor,
  onPropose,
  tradeEnabled = false,
  expandedEnabled = false,
  ownNationId,
  map,
}: Props) {
  const trpc = useTRPC();
  const [form, setForm] = useState<ComposeState>(emptyCompose);
  const ids = { target: useId(), note: useId() };
  const target = targets.find((t) => t.nation.id === form.toNationId);
  const parties = map?.nations.filter(({ id }) => id === ownNationId || id === target?.nation.id) ?? [];
  const cities = clauseCities(map?.cities ?? [], parties);
  const built = buildClauses(form, target?.relation, expandedEnabled ? { parties, cities } : undefined);
  const labels = {
    city: (key: number) => map?.cities.find((city) => city.key === key)?.name ?? `도시 ${key}`,
    nation: (id: number) => parties.find((nation) => nation.id === id)?.name ?? `국가 ${id}`,
    recipient: (id: number) => parties.find((nation) => nation.id !== id)?.name ?? '상대 국가',
  };
  const cityOption = (city: (typeof cities.passage)[number]) =>
    `${city.name} (${city.nationId === null ? '공백지' : labels.nation(city.nationId)})`;
  const unavailableCities = !target ? '상대 국가를 고르세요.' : !map ? '지도에서 도시를 확인하지 못했습니다.' : null;

  // 비용과 문제는 서버가 계산한다. 저장하지 않는 조회라 쓰는 동안 바로 다시 묻는다.
  const quoteInput =
    form.toNationId !== null && built.clauses.length > 0 && built.problems.length === 0
      ? { worldId, toNationId: form.toNationId, clauses: built.clauses }
      : null;
  // 조항이 바뀌면 키가 바뀐다. 앞 조항의 견적을 새 조항의 것처럼 남기지 않는다.
  const quote = useQuery({
    ...trpc.treaty.quote.queryOptions(quoteInput ?? skipToken),
    retry: retryUnlessClientError,
  });
  const quoteData = quoteInput !== null ? quote.data : undefined;
  const serverProblem = quoteData?.problem ?? null;

  const set = <K extends keyof ComposeState>(key: K, value: ComposeState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const busy = form.toNationId !== null ? busyFor(form.toNationId) : null;
  const blocked = busy ?? built.problems[0] ?? serverProblem?.reason ?? null;

  const submit = () => {
    if (blocked !== null || form.toNationId === null) return;
    onPropose({ toNationId: form.toNationId, clauses: built.clauses });
  };

  const peaceOk = canChoosePeace(target?.relation);
  const enforcedKinds = built.clauses
    .filter((c) => isEnforced(c.kind))
    .map((c) =>
      c.kind === 'passage' || c.kind === 'tribute' || c.kind === 'cityTransfer'
        ? describeClause(c, labels)
        : CLAUSE_LABELS[c.kind],
    );
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
            // 상대가 바뀌면 관계가 달라지므로 종전은 다시 고른다.
            setForm((prev) => ({ ...prev, ...emptyExpandedClauses(), toNationId: id, peace: false }));
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
            {relationText(target)}
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
        />

        <ClauseRow
          label={CLAUSE_LABELS.nonAggression}
          checked={form.nonAggression.on}
          onToggle={(on) => set('nonAggression', { ...form.nonAggression, on })}
        >
          <label className={styles.inline}>
            <span>기간(개월)</span>
            <input
              type="number"
              inputMode="numeric"
              className="num"
              min={NON_AGGRESSION_MONTHS.min}
              max={NON_AGGRESSION_MONTHS.max}
              step={1}
              value={form.nonAggression.months}
              onChange={(e) => set('nonAggression', { ...form.nonAggression, months: e.target.value })}
            />
          </label>
        </ClauseRow>

        <ClauseRow
          label={CLAUSE_LABELS.note}
          checked={form.note.on}
          onToggle={(on) => set('note', { ...form.note, on })}
        >
          <label className={styles.inline} htmlFor={ids.note}>
            <span>
              문장 ({noteLength(form.note.text)}/{NOTE_MAX_LENGTH}자)
            </span>
          </label>
          <textarea
            id={ids.note}
            className={styles.note}
            rows={2}
            value={form.note.text}
            onChange={(e) => set('note', { ...form.note, text: e.target.value })}
          />
        </ClauseRow>

        {tradeEnabled ? (
          <ClauseRow
            label={CLAUSE_LABELS.trade}
            checked={form.trade?.on ?? false}
            onToggle={(on) => set('trade', { months: form.trade?.months ?? '24', on })}
          >
            <label className={styles.inline}>
              교역 기간(개월)
              <input
                type="number"
                min={1}
                max={120}
                step={1}
                value={form.trade?.months ?? '24'}
                onChange={(e) => set('trade', { on: form.trade?.on ?? false, months: e.target.value })}
              />
            </label>
          </ClauseRow>
        ) : null}
        {expandedEnabled ? (
          <>
            <ClauseRow
              label={CLAUSE_LABELS.passage}
              checked={form.passage.on}
              disabledReason={
                unavailableCities ?? (cities.passage.length === 0 ? '고를 수 있는 통행 도시가 없습니다.' : null)
              }
              onToggle={(on) => set('passage', { ...form.passage, on })}
            >
              <label className={styles.inline}>
                통행 기간(개월)
                <input
                  type="number"
                  min={1}
                  max={TREATY_MAX_MONTHS}
                  step={1}
                  value={form.passage.months}
                  onChange={(e) => set('passage', { ...form.passage, months: e.target.value })}
                />
              </label>
              <fieldset className={styles.passageCities}>
                <legend>통행 도시</legend>
                <ul>
                  {cities.passage.map((city) => (
                    <li key={city.key}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={form.passage.cityKeys.includes(city.key)}
                          onChange={(e) =>
                            set('passage', {
                              ...form.passage,
                              cityKeys: e.target.checked
                                ? [...form.passage.cityKeys, city.key]
                                : form.passage.cityKeys.filter((key) => key !== city.key),
                            })
                          }
                        />
                        {cityOption(city)}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            </ClauseRow>
            <ClauseRow
              label={CLAUSE_LABELS.tribute}
              checked={form.tribute.on}
              disabledReason={unavailableCities}
              onToggle={(on) => set('tribute', { ...form.tribute, on })}
            >
              <label className={styles.inline}>
                원조를 보내는 국가
                <select
                  value={form.tribute.payerNationId ?? ''}
                  onChange={(e) =>
                    set('tribute', {
                      ...form.tribute,
                      payerNationId: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">고르세요</option>
                  {parties.map((nation) => (
                    <option key={nation.id} value={nation.id}>
                      {nation.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.inline}>
                원조 기간(개월)
                <input
                  type="number"
                  min={1}
                  max={TREATY_MAX_MONTHS}
                  step={1}
                  value={form.tribute.months}
                  onChange={(e) => set('tribute', { ...form.tribute, months: e.target.value })}
                />
              </label>
              {(['gold', 'rice'] as const).map((resource) => (
                <label className={styles.inline} key={resource}>
                  {resource === 'gold' ? '매달 금' : '매달 쌀'}
                  <input
                    type="number"
                    min={0}
                    max={TRIBUTE_MAX_AMOUNT}
                    step={1}
                    value={form.tribute[resource]}
                    onChange={(e) => set('tribute', { ...form.tribute, [resource]: e.target.value })}
                  />
                </label>
              ))}
            </ClauseRow>
            <ClauseRow
              label={CLAUSE_LABELS.cityTransfer}
              checked={form.cityTransfer.on}
              disabledReason={
                unavailableCities ?? (cities.transfer.length === 0 ? '이양할 비수도 도시가 없습니다.' : null)
              }
              onToggle={(on) => set('cityTransfer', { ...form.cityTransfer, on })}
            >
              <label className={styles.inline}>
                이양할 도시
                <select
                  value={
                    cities.transfer.some(
                      (city) =>
                        city.key === form.cityTransfer.cityKey && city.nationId === form.cityTransfer.giverNationId,
                    )
                      ? (form.cityTransfer.cityKey ?? '')
                      : ''
                  }
                  onChange={(e) => {
                    const city = cities.transfer.find((candidate) => candidate.key === Number(e.target.value));
                    set('cityTransfer', {
                      ...form.cityTransfer,
                      cityKey: city?.key ?? null,
                      giverNationId: city?.nationId ?? null,
                    });
                  }}
                >
                  <option value="">고르세요</option>
                  {cities.transfer.map((city) => (
                    <option key={city.key} value={city.key}>
                      {cityOption(city)}
                    </option>
                  ))}
                </select>
              </label>
            </ClauseRow>
          </>
        ) : null}
        {UNSUPPORTED_CLAUSE_LABELS.filter((label) => (label === '교역 허용' ? !tradeEnabled : !expandedEnabled)).map(
          (label) => (
            <ClauseRow
              key={label}
              label={label}
              checked={false}
              disabledReason={UNSUPPORTED_CLAUSE_REASON}
              onToggle={() => undefined}
              unsupported
            />
          ),
        )}
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
          {costText(quoteInput !== null, quoteData, quote.isError)}
        </p>
        {serverProblem ? (
          <p className={styles.problem} role="alert" data-testid="treaty-quote-problem">
            {serverProblem.reason}
          </p>
        ) : null}
        <p className={styles.muted}>
          상대는 {PROPOSAL_RESPONSE_MONTHS}개월 안에 답합니다. 그 안에 답하지 않으면 제안이 끝납니다.
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
  unsupported,
  children,
}: {
  label: string;
  checked: boolean;
  disabledReason?: string | null;
  onToggle: (on: boolean) => void;
  unsupported?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={styles.clauseRow} data-clause={label} data-unsupported={unsupported ? 'true' : undefined}>
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
    </div>
  );
}
