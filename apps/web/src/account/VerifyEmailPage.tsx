import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { describeFailure, retryAfterSeconds } from '../auth/credentials';
import form from '../auth/AuthForm.module.css';
import { useTRPC } from '../trpc';
import { AccountError, AccountFrame } from './AccountParts';
import styles from './Account.module.css';

const route = getRouteApi('/verify-email');
export function VerificationRequest({ email }: { email: string }) {
  const trpc = useTRPC();
  const [until, setUntil] = useState(0),
    [now, setNow] = useState(Date.now);
  function wait(seconds: number) {
    const at = Date.now();
    setNow(at);
    setUntil(at + seconds * 1000);
  }
  const mutation = useMutation({
    ...trpc.account.resendVerification.mutationOptions(),
    gcTime: 0,
    onSuccess() {
      wait(60);
    },
    onError(error) {
      const seconds = retryAfterSeconds(error);
      if (seconds !== null) wait(seconds);
    },
  });
  useEffect(() => {
    if (!until) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [until]);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const [local, domain] = email.split('@');
  return (
    <div>
      <p>
        {local?.slice(0, 2)}…@{domain}의 메일함을 확인하세요. 인증 링크는 24시간 동안 한 번 쓸 수 있습니다.
      </p>
      {mutation.isSuccess ? <p role="status">인증 메일을 보냈습니다. 메일함을 확인하세요.</p> : null}
      {mutation.isError ? <AccountError error={mutation.error} /> : null}
      <button
        type="button"
        className={`${form.submit} ${styles.touch}`}
        disabled={mutation.isPending || seconds > 0}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending
          ? '보내는 중…'
          : seconds > 0
            ? `인증 메일 다시 보내기 (${seconds}초)`
            : '인증 메일 다시 보내기'}
      </button>
    </div>
  );
}

export function VerifyEmailPage() {
  const { accountToken } = route.useRouteContext();
  const trpc = useTRPC(),
    queryClient = useQueryClient();
  const account = useQuery({
    ...trpc.account.get.queryOptions(),
    enabled: accountToken.kind === 'missing',
    staleTime: 0,
  });
  const mutation = useMutation({
    ...trpc.account.verifyEmail.mutationOptions(),
    gcTime: 0,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: trpc.account.get.queryKey() });
    },
  });
  const { mutate } = mutation;
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (accountToken.kind === 'token' && started.current !== accountToken.token) {
      started.current = accountToken.token;
      mutate({ token: accountToken.token });
    }
  }, [accountToken, mutate]);
  let body;
  if (accountToken.kind === 'invalid') body = <p role="alert">인증 링크를 확인하거나 새로 요청하세요.</p>;
  else if (accountToken.kind === 'token')
    body = mutation.isSuccess ? (
      <p role="status">이메일 인증을 마쳤습니다.</p>
    ) : mutation.isError ? (
      <AccountError error={mutation.error} />
    ) : (
      <p role="status">이메일을 확인하고 있습니다…</p>
    );
  else if (account.isError) body = <AccountError error={account.error} />;
  else if (!account.data) body = <p role="status">계정을 확인하고 있습니다…</p>;
  else
    body = account.data.emailVerified ? (
      <p role="status">이메일 인증을 마쳤습니다.</p>
    ) : (
      <VerificationRequest email={account.data.email} />
    );
  return (
    <AccountFrame title="이메일 인증" privateLink>
      {body}
      {accountToken.kind === 'token' && mutation.isError && describeFailure(mutation.error).kind === 'retry' ? (
        <button
          type="button"
          className={`${form.submit} ${styles.touch}`}
          onClick={() => mutate({ token: accountToken.token })}
        >
          다시 확인
        </button>
      ) : null}
      {accountToken.kind !== 'missing' ? (
        <div className={styles.links}>
          <Link to="/verify-email">인증 메일 다시 받기</Link>
        </div>
      ) : null}
    </AccountFrame>
  );
}
