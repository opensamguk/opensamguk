import { useId, useState } from 'react';
import { Portrait } from '../portrait/Portrait';
import { Tag } from '../ui/Tag';
import { injuryText, matchesCandidate, statEntries, traitTags, type Candidate } from './candidates';
import styles from './CandidatePicker.module.css';

const n = (value: number) => value.toLocaleString('ko-KR');

// 인사부 임명 후보 카드 목록 (INT-25 단계 3, 원작 인사부 임명 대상 선택 창).
// 카드를 누르면 그 장수를 고른다. 보내기는 직책 줄의 「임명」이 한다.
export function CandidatePicker({
  id,
  title,
  candidates,
  chosen,
  detailsState,
  onPick,
}: {
  id: string;
  title: string;
  candidates: readonly Candidate[];
  chosen: number | null;
  // 능력치(nation.get)를 받는 중이면 'loading', 못 받았으면 'error'. 카드는 이름·도시·직책만으로도 고를 수 있다.
  detailsState: 'ready' | 'loading' | 'error';
  onPick: (generalId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const shown = candidates.filter((candidate) => matchesCandidate(candidate, query));
  return (
    <div className={styles.picker} id={id} role="group" aria-label={`${title} 임명 후보`}>
      <div className={styles.toolbar}>
        <label className={styles.search} htmlFor={searchId}>
          <span>후보 찾기</span>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="이름·도시"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className={styles.count} aria-live="polite">
          후보 {n(shown.length)}명
        </span>
      </div>
      {detailsState === 'ready' ? null : (
        <p className={styles.note} role="note">
          {detailsState === 'loading' ? '능력치를 불러오는 중입니다.' : '능력치를 불러오지 못했습니다.'}
        </p>
      )}
      {shown.length === 0 ? (
        <p className={styles.empty}>
          {candidates.length === 0 ? '임명할 수 있는 장수가 없습니다.' : '찾는 장수가 없습니다.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {shown.map((candidate) => (
            <li key={candidate.member.generalId}>
              <CandidateCard
                candidate={candidate}
                selected={chosen === candidate.member.generalId}
                onPick={() => onPick(candidate.member.generalId)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  selected,
  onPick,
}: {
  candidate: Candidate;
  selected: boolean;
  onPick: () => void;
}) {
  const { member, label, detail, state } = candidate;
  const traits = traitTags(detail);
  return (
    <button
      type="button"
      className={styles.card}
      data-state={state.kind}
      data-general-id={member.generalId}
      aria-pressed={selected}
      onClick={onPick}
    >
      {/* 이름은 카드 글자로 읽으므로 초상 대체 글은 읽지 않는다. */}
      <span className={styles.face} aria-hidden="true">
        <Portrait id={detail?.portraitId ?? null} name={label} variant="icon" shape="round" className={styles.icon} />
      </span>
      <span className={styles.body}>
        <span className={styles.nameLine}>
          <strong className={styles.name}>{label}</strong>
          {member.isHuman ? <Tag tone="accent">사람</Tag> : <Tag tone="muted">NPC</Tag>}
          {state.kind === 'office' ? (
            <Tag tone="warning" title="옮기면 지금 자리가 빕니다.">
              {state.title} 재직
            </Tag>
          ) : (
            <Tag tone="info">임명 가능</Tag>
          )}
        </span>
        <span className={styles.meta}>
          {member.city.name} · {member.title}
          {member.tenureYears === undefined ? '' : ` · 임관 ${n(member.tenureYears)}년`}
        </span>
        {detail ? (
          <>
            <span className={styles.stats}>
              {statEntries(detail).map((stat) => (
                <span key={stat.key} className={styles.stat} data-stat={stat.key}>
                  <span className={styles.statLabel}>{stat.label}</span>{' '}
                  <span className={styles.statValue}>{stat.value}</span>
                </span>
              ))}
            </span>
            <span className={styles.meta}>
              병력 {n(detail.troops)} · 부상 {injuryText(detail.injury)}
            </span>
          </>
        ) : null}
        {traits.length > 0 ? (
          <span className={styles.traits}>
            {traits.map((trait) => (
              <Tag key={trait} tone="muted">
                {trait}
              </Tag>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}
