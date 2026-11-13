import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import { QueryError } from '../game/QueryState';
import { retryUnlessClientError } from '../game/errors';
import styles from '../diplomacy/Diplomacy.module.css';

const ROLES = { AMBASSADOR: '외교권자', ADVISER: '조언자' } as const;
type Role = keyof typeof ROLES;

export function DiplomaticDelegates({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.diplomaticDocuments.delegates.queryOptions({ worldId }),
    retry: retryUnlessClientError,
  });
  const mutation = useMutation(trpc.diplomaticDocuments.setDelegate.mutationOptions());
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  if (query.isError)
    return (
      <QueryError error={query.error} notFound="외교 직책을 찾을 수 없습니다" onRetry={() => void query.refetch()} />
    );
  if (!query.data) return null;
  const { canAppoint, members } = query.data;
  const candidates = members.filter(({ officerLevel, role: current }) => officerLevel < 11 || current !== null);
  const member = candidates.find(({ id }) => String(id) === target);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member) return;
    mutation.mutate(
      { worldId, generalId: member.id, role: role || null },
      {
        onSuccess: () => {
          setTarget('');
          setRole('');
          void query.refetch();
        },
      },
    );
  }

  return (
    <section className={styles.card} aria-labelledby="diplomatic-delegates">
      <h2 id="diplomatic-delegates">외교권자와 조언자</h2>
      <dl className={styles.facts}>
        {Object.entries(ROLES).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {members
                .filter((entry) => entry.role === key)
                .map(({ name }) => name)
                .join(', ') || '지정 없음'}
            </dd>
          </div>
        ))}
      </dl>
      {canAppoint ? (
        <form className={`${styles.composer} ${styles.documentForm}`} onSubmit={save}>
          <label>
            지정할 장수
            <select
              value={target}
              required
              disabled={mutation.isPending}
              onChange={(event) => {
                setTarget(event.target.value);
                setRole(candidates.find(({ id }) => String(id) === event.target.value)?.role ?? '');
              }}
            >
              <option value="">장수 선택</option>
              {candidates.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            외교 직책
            <select
              value={role}
              disabled={mutation.isPending}
              onChange={(event) => setRole(event.target.value as Role | '')}
            >
              <option value="">지정 해제</option>
              <option value="AMBASSADOR">외교권자</option>
              <option value="ADVISER">조언자</option>
            </select>
          </label>
          <div>
            <button className={styles.primary} disabled={!member || (member.role ?? '') === role || mutation.isPending}>
              적용
            </button>
          </div>
        </form>
      ) : null}
      {mutation.isError ? (
        <p role="alert">{serverMessage(mutation.error) ?? '외교 직책을 바꾸지 못했습니다.'}</p>
      ) : null}
    </section>
  );
}
