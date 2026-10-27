import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/credentials';
import form from '../auth/AuthForm.module.css';
import { useTRPC } from '../trpc';
import { AccountError, AccountFrame } from './AccountParts';
import styles from './Account.module.css';

const route = getRouteApi('/reset-password');
export function ResetPasswordPage() {
  const { accountToken } = route.useRouteContext();
  const trpc = useTRPC(),
    queryClient = useQueryClient(),
    id = useId();
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    ...trpc.account.resetPassword.mutationOptions(),
    gcTime: 0,
    onSuccess() {
      queryClient.clear();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || accountToken.kind !== 'token') return;
    const data = new FormData(event.currentTarget),
      password = String(data.get('password') ?? ''),
      confirm = String(data.get('confirm') ?? '');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      setError(`비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자입니다`);
      return;
    }
    if (password !== confirm) {
      setError('두 비밀번호가 다릅니다.');
      return;
    }
    setError(undefined);
    mutation.mutate({ token: accountToken.token, password });
  }
  return (
    <AccountFrame title="새 비밀번호" privateLink>
      {mutation.isSuccess ? (
        <p role="status">비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요.</p>
      ) : accountToken.kind !== 'token' ? (
        <p role="alert">재설정 링크를 확인하거나 새로 요청하세요.</p>
      ) : (
        <form className={form.form} onSubmit={submit} noValidate aria-busy={mutation.isPending}>
          <p>이 계정으로 로그인한 다른 기기의 세션도 모두 끝납니다.</p>
          <div className={form.field}>
            <label htmlFor={id + '-password'}>새 비밀번호</label>
            <input
              id={id + '-password'}
              name="password"
              type="password"
              autoComplete="new-password"
              className={`${form.input} ${styles.touch}`}
              aria-describedby={id + '-hint'}
            />
            <p id={id + '-hint'} className={form.hint}>
              10~128자
            </p>
          </div>
          <div className={form.field}>
            <label htmlFor={id + '-confirm'}>새 비밀번호 확인</label>
            <input
              id={id + '-confirm'}
              name="confirm"
              type="password"
              autoComplete="new-password"
              className={`${form.input} ${styles.touch}`}
            />
          </div>
          {error ? (
            <p role="alert" className={form.fieldError}>
              {error}
            </p>
          ) : null}
          {mutation.isError ? <AccountError error={mutation.error} /> : null}
          <button className={`${form.submit} ${styles.touch}`} disabled={mutation.isPending}>
            {mutation.isPending ? '변경 중…' : '비밀번호 바꾸기'}
          </button>
        </form>
      )}
      <div className={styles.links}>
        <Link to="/forgot-password">새 재설정 메일 받기</Link>
      </div>
    </AccountFrame>
  );
}
