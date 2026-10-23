import { Link, useRouterState } from '@tanstack/react-router';
import { useId } from 'react';
import { errorCode } from '../turns/apiError';
import type { PolicyKey } from './contract';
import styles from './PolicyBar.module.css';
import { directionParticle, findOption, policySentence } from './policyText';
import { policyView, usePolicyChange, usePolicyQuery } from './usePolicy';

// 예턴 편집 위의 기본 방침 고르기 (T2-14). 고르면 예턴 저장과 따로 바로 보낸다.
// 엔진이 처리하기 전에는 고른 방침 옆에 처리 중을 두고, 거절되면 이유를 보이며 고르기 칸을 지금 방침으로 되돌린다.
export function PolicyBar({ worldId }: { worldId: string }) {
  const query = usePolicyQuery(worldId);
  const change = usePolicyChange(worldId);
  const selectId = useId();
  const href = useRouterState({ select: (state) => state.location.href });

  if (!query.data) {
    // 장수가 없으면 아래 편집기가 장수 만들기를 안내한다. 방침 줄은 비워 둔다.
    if (query.isError && errorCode(query.error) === 'NOT_FOUND') return null;
    return (
      <div className={styles.bar} data-testid="policy-bar">
        {query.isError ? (
          <p className={styles.muted}>
            기본 방침을 불러오지 못했습니다.{' '}
            <button type="button" className={styles.linkButton} onClick={() => void query.refetch()}>
              다시 시도
            </button>
          </p>
        ) : (
          <p className={styles.muted}>기본 방침을 불러오는 중…</p>
        )}
      </div>
    );
  }

  const data = query.data;
  const view = policyView(data, change);
  const selected = findOption(data, view.selected);
  const current = findOption(data, data.current);

  return (
    <div className={styles.bar} data-testid="policy-bar">
      <div className={styles.row}>
        <label className={styles.label} htmlFor={selectId}>
          기본 방침
        </label>
        <select
          id={selectId}
          className={styles.select}
          value={view.selected}
          disabled={view.processing}
          onChange={(e) => change.choose(e.target.value as PolicyKey)}
        >
          {data.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>
        <span role="status" className={styles.state} data-testid="policy-state">
          {view.processing ? '처리 중' : view.confirmed ? '바꿨습니다' : ''}
        </span>
      </div>
      <p className={styles.sentence} data-testid="policy-sentence">
        {policySentence(view.processing ? current : selected)}
        {view.processing && selected && selected !== current
          ? ` 엔진이 처리하면 ${selected.name}${directionParticle(selected.name)} 바뀝니다.`
          : null}
      </p>
      {view.rejected ? (
        <p className={styles.error} role="alert" data-testid="policy-rejected">
          {findOption(data, view.rejected.policy)?.name ?? view.rejected.policy}
          {directionParticle(findOption(data, view.rejected.policy)?.name ?? '')} 바꾸지 못했습니다.{' '}
          {view.rejected.reason}
        </p>
      ) : null}
      {change.error?.kind === 'error' ? (
        <p className={styles.error} role="alert">
          {change.error.message}
        </p>
      ) : null}
      {change.error?.kind === 'auth' ? (
        <p className={styles.error} role="alert">
          로그인이 풀려 방침을 보내지 못했습니다.{' '}
          <Link to="/login" search={{ next: href }}>
            다시 로그인
          </Link>
        </p>
      ) : null}
    </div>
  );
}
