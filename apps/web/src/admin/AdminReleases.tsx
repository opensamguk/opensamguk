import type { AppRouter } from '@opensamguk/server/router';
import { useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useRef, useState, type FormEvent } from 'react';
import { publicFailure } from '../auth/credentials';
import { useTRPC, useTRPCClient } from '../trpc';
import styles from './AdminPages.module.css';

type ReleaseInput = inferRouterInputs<AppRouter>['admin']['release']['request'];
type Status = inferRouterOutputs<AppRouter>['admin']['release']['status'];
type Candidate = NonNullable<Status['control']>['candidates'][number];
const actions = { DEPLOY: '배포', ROLLBACK: '되돌리기' } as const;
const statuses = {
  QUEUED: '접수',
  RUNNING: '실행 중',
  SUCCEEDED: '완료',
  FAILED: '실패',
  NEEDS_OWNER: '호스트 점검 필요',
} as const;

export function AdminReleases() {
  const expectedUserId = useRouteContext({ from: '/admin' }).adminViewerId;
  return <ReleaseConsole key={expectedUserId} expectedUserId={expectedUserId} />;
}

function ReleaseConsole({ expectedUserId }: { expectedUserId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const status = useQuery({
    ...trpc.admin.release.status.queryOptions({ expectedUserId }),
    refetchInterval: 5_000,
    retry: false,
  });
  const [selected, setSelected] = useState<{ candidate: Candidate; currentRevision: string } | null>(null);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<ReleaseInput | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const data = status.isError ? undefined : status.data;
  const control = data?.control;
  const active = data?.requests.some(({ status }) => ['QUEUED', 'RUNNING', 'NEEDS_OWNER'].includes(status));
  const stillAllowed =
    control &&
    selected &&
    control.currentRevision === selected.currentRevision &&
    control.candidates.some(
      (candidate) =>
        candidate.revision === selected.candidate.revision &&
        candidate.manifestSha256 === selected.candidate.manifestSha256 &&
        candidate.operation === selected.candidate.operation,
    );

  async function send(input: ReleaseInput) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setResult(null);
    setAttempt(input);
    try {
      const receipt = await client.admin.release.request.mutate(input);
      setResult({ error: false, text: `${statuses[receipt.status]} · ${receipt.id}` });
      setAttempt(null);
      setSelected(null);
      setReason('');
      await status.refetch();
    } catch (error) {
      const code = publicFailure(error)?.code;
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'BAD_REQUEST') {
        setAttempt(null);
        setSelected(null);
        setResult({ error: true, text: '요청할 수 없습니다. 현재 배포판과 승인 목록을 확인하세요.' });
        await status.refetch();
      } else if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        setAttempt(null);
        setSelected(null);
        setReason('');
        setResult({ error: true, text: '관리자 권한을 확인하세요.' });
        await status.refetch();
      } else {
        setResult({ error: true, text: '접수 응답을 받지 못했습니다. 같은 요청으로 다시 확인하세요.' });
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !stillAllowed || active || !reason.trim()) return;
    const { candidate, currentRevision } = selected;
    void send({
      id: crypto.randomUUID(),
      expectedUserId,
      operation: candidate.operation,
      targetRevision: candidate.revision,
      manifestSha256: candidate.manifestSha256,
      expectedRevision: currentRevision,
      reason: reason.trim(),
    });
  }

  return (
    <>
      <h2>배포 관리</h2>
      {status.isPending ? <p>배포 상태 확인 중</p> : null}
      {status.isError ? <p role="alert">배포 상태를 읽지 못했습니다.</p> : null}
      {!status.isPending && !status.isError && !control ? <p>배포 호스트에 연결되어 있지 않습니다.</p> : null}
      {control ? (
        <>
          <p>
            현재 운영판 <code>{control.currentRevision}</code>
          </p>
          <h3>승인된 대상</h3>
          {control.candidates.length === 0 ? <p>실행할 수 있는 배포판이 없습니다.</p> : null}
          <ul>
            {control.candidates.map((candidate) => (
              <li key={`${candidate.operation}:${candidate.revision}`}>
                <button
                  type="button"
                  disabled={busy || Boolean(active) || Boolean(attempt)}
                  onClick={() => {
                    setSelected({ candidate, currentRevision: control.currentRevision });
                    setResult(null);
                  }}
                >
                  {actions[candidate.operation]} <code>{candidate.revision.slice(0, 12)}</code>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {selected && !attempt && stillAllowed && !active ? (
        <form className={styles.form} onSubmit={submit}>
          <p>
            {actions[selected.candidate.operation]} 대상 <code>{selected.candidate.revision}</code>
          </p>
          <label>
            실행 사유
            <input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
          </label>
          <button type="submit" disabled={busy || !reason.trim()}>
            {actions[selected.candidate.operation]} 요청
          </button>
          <button type="button" disabled={busy} onClick={() => setSelected(null)}>
            취소
          </button>
        </form>
      ) : null}
      {attempt && !status.isError ? (
        <button type="button" disabled={busy} onClick={() => void send(attempt)}>
          같은 요청 확인
        </button>
      ) : null}
      {result ? <p role={result.error ? 'alert' : 'status'}>{result.text}</p> : null}
      <h3>실행 이력</h3>
      {data?.requests.length === 0 ? <p>배포 요청이 없습니다.</p> : null}
      <ul>
        {data?.requests.map((request) => (
          <li key={request.id}>
            {actions[request.operation]} <code>{request.targetRevision.slice(0, 12)}</code> · {statuses[request.status]}{' '}
            ·{' '}
            <time dateTime={new Date(request.requestedAt).toISOString()}>
              {new Date(request.requestedAt).toLocaleString('ko-KR')}
            </time>
          </li>
        ))}
      </ul>
    </>
  );
}
