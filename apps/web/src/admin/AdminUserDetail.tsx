import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useId } from 'react';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './AdminPages.module.css';

type Detail = inferRouterOutputs<AppRouter>['admin']['user']['get'];
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  dateStyle: 'medium',
  timeStyle: 'short',
});
function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {time.format(new Date(value))}
    </time>
  );
}

export function AdminUserDetail({
  userId,
  onChange,
  onRead,
  data,
  pending,
  error,
  disabled = false,
}: {
  userId: string;
  onChange: (value: string) => void;
  onRead: (value: string) => void;
  data: Detail | null;
  pending: boolean;
  error: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <section aria-label="사용자 상세">
      <h3>사용자 상세</h3>
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onRead(userId);
        }}
      >
        <label htmlFor={id}>
          상세 조회할 사용자 UUID
          <input
            id={id}
            value={userId}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            maxLength={36}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={pending || disabled}>
          상세 조회
        </button>
      </form>
      <p>
        버튼을 누를 때만 조회하고 결과가 없어도 감사 기록을 남깁니다. 참가 장수와 제재는 각각 최대50건을 표시합니다.
      </p>
      {pending ? <LoadingState>사용자 상세 조회 중</LoadingState> : null}
      {error ? <ErrorState title={error} /> : null}
      {data ? (
        <>
          <dl className={styles.userFacts}>
            <dt>사용자</dt>
            <dd>
              {data.email}
              <br />
              <code>{data.userId}</code>
            </dd>
            <dt>상태·역할</dt>
            <dd>
              {data.status} · {data.role}
            </dd>
            <dt>가입 시각</dt>
            <dd>
              <Time value={data.createdAt} />
            </dd>
            <dt>이메일 인증</dt>
            <dd>{data.emailVerified ? '확인됨' : '확인 필요'}</dd>
          </dl>
          <h4>참가 장수</h4>
          <p>
            전체{data.generalCount}명 중{data.generals.length}명, 월드 생성 시각 역순입니다.
          </p>
          {data.generalCount > data.generals.length ? (
            <p>표시하지 않은 참가 장수가 있습니다. 전체 이력은 아닙니다.</p>
          ) : null}
          {data.generals.length === 0 ? (
            <p>참가 장수가 없습니다.</p>
          ) : (
            <ul className={styles.userHistory} aria-label="참가 장수 목록">
              {data.generals.map((general) => (
                <li key={general.worldId + ':' + general.generalId}>
                  {general.name} (장수{general.generalId}) · 국가{general.nationId ?? '없음'}
                  <br />
                  {general.worldName} · {general.worldStatus}
                  <br />
                  <code>{general.worldId}</code>
                </li>
              ))}
            </ul>
          )}
          <h4>제재 이력</h4>
          <p>
            전체{data.sanctionCount}건 중{data.sanctions.length}건, 생성 시각 역순입니다.
          </p>
          {data.sanctionCount > data.sanctions.length ? (
            <p>표시하지 않은 제재가 있습니다. 전체 이력은 아닙니다.</p>
          ) : null}
          {data.sanctions.length === 0 ? (
            <p>제재 이력이 없습니다.</p>
          ) : (
            <ul className={styles.userHistory} aria-label="제재 이력 목록">
              {data.sanctions.map((sanction) => (
                <li key={sanction.sanctionId}>
                  <code>{sanction.sanctionId}</code>
                  <br />
                  {sanction.worldId === null
                    ? '계정 전체'
                    : `${sanction.worldName ?? '월드'} (${sanction.worldId})`} ·{' '}
                  {sanction.active ? '유효' : sanction.liftedAt ? '해제됨' : '만료됨'}
                  <p className={styles.noticeBody}>{sanction.reason}</p>
                  생성 <Time value={sanction.createdAt} />
                  <br />
                  만료 {sanction.expiresAt ? <Time value={sanction.expiresAt} /> : '무기한'}
                  <br />
                  해제 {sanction.liftedAt ? <Time value={sanction.liftedAt} /> : '해제 기록 없음'}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
