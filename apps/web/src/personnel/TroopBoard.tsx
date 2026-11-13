import { useMutation, useQuery } from '@tanstack/react-query';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs } from '@trpc/server';
import { useState, type FormEvent } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { Portrait } from '../portrait/Portrait';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import styles from './Personnel.module.css';

type Change = inferRouterInputs<AppRouter>['troop']['update']['change'];

export function TroopBoard({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.troop.list.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: (query) => (query.state.data?.latest?.status === 'PENDING' ? 1000 : false),
  });
  const update = useMutation(trpc.troop.update.mutationOptions());
  const [name, setName] = useState('');
  if (query.isError)
    return (
      <p role="alert">
        부대를 불러오지 못했습니다.{' '}
        <button type="button" onClick={() => void query.refetch()}>
          다시 시도
        </button>
      </p>
    );
  if (!query.data?.enabled) return null;

  const { actorId, canCreate, canChange, myTroop, troops, latest } = query.data;
  const pending = update.isPending || latest?.status === 'PENDING';
  const rejected = latest?.status === 'REJECTED' ? latest.message : null;
  const submit = (change: Change) =>
    update.mutate(
      { worldId, expectedGeneralId: actorId, change },
      {
        onSuccess: async () => {
          await query.refetch();
          if (change.action === 'create' || change.action === 'rename') setName('');
        },
      },
    );
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (myTroop === actorId) submit({ action: 'rename', name });
    else if (canCreate) submit({ action: 'create', name });
  };

  return (
    <section className={styles.section} aria-labelledby="troop-heading">
      <h2 id="troop-heading">부대</h2>
      {troops.length === 0 ? <p>소속 국가에 부대가 없습니다.</p> : null}
      <div className={styles.localOffices}>
        {troops.map((troop) => (
          <article key={troop.leaderId} className={styles.section}>
            <h3>
              {troop.name}
              {myTroop === troop.leaderId ? ' · 내 부대' : ''}
            </h3>
            <div className={styles.controls}>
              <Portrait id={troop.leader.portraitId} name={troop.leader.name} variant="icon" size={24} decorative />
              <strong>{troop.leader.name}</strong>
              <span>{troop.leader.cityName}</span>
              <span>{troop.members.length + 1}명</span>
            </div>
            {troop.nextTurnAt ? (
              <span>
                다음 턴 {new Date(troop.nextTurnAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            ) : null}
            <span>
              {troop.gatherSlots.map((reserved, index) => `${index + 1}번 ${reserved ? '집합' : '—'}`).join(' · ')}
            </span>
            {troop.members.length ? (
              <ul>
                {troop.members.map((member) => (
                  <li key={member.id}>
                    {member.name}
                    {member.cityKey !== troop.leader.cityKey ? ` (${member.cityName ?? '도시 미상'})` : ''}
                    {canChange && actorId === troop.leaderId ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => submit({ action: 'kick', memberId: member.id })}
                      >
                        추방
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {canChange && myTroop === null ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => submit({ action: 'join', leaderId: troop.leaderId })}
              >
                가입
              </button>
            ) : null}
            {canChange && myTroop === troop.leaderId ? (
              <button type="button" disabled={pending} onClick={() => submit({ action: 'leave' })}>
                {actorId === troop.leaderId ? '해산' : '탈퇴'}
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {canCreate || (canChange && myTroop === actorId) ? (
        <form className={styles.controls} onSubmit={save}>
          <label>
            부대 이름{' '}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={18}
              required
              disabled={pending}
            />
          </label>
          <button disabled={pending}>{myTroop === actorId ? '이름 변경' : '부대 창설'}</button>
        </form>
      ) : null}
      {pending ? <p role="status">부대 변경 처리 중</p> : null}
      {rejected || update.isError ? (
        <p role="alert">
          {update.isError ? (serverMessage(update.error) ?? '부대 변경을 접수하지 못했습니다.') : rejected}
        </p>
      ) : null}
    </section>
  );
}
