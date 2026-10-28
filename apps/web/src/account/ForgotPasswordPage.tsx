import { useMutation } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { validateEmail } from '../auth/credentials';
import form from '../auth/AuthForm.module.css';
import { useTRPC } from '../trpc';
import { AccountError, AccountFrame } from './AccountParts';
import styles from './Account.module.css';

export function ForgotPasswordPage() {
  const trpc = useTRPC(),
    id = useId();
  const [emailError, setEmailError] = useState<string>();
  const mutation = useMutation({ ...trpc.account.requestPasswordReset.mutationOptions(), gcTime: 0 });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    const error = validateEmail(email);
    setEmailError(error);
    if (!error) mutation.mutate({ email });
  }
  return (
    <AccountFrame title="비밀번호 재설정">
      <p>가입한 이메일을 입력하세요. 재설정 링크는30분 동안 한 번 쓸 수 있습니다.</p>
      {mutation.isSuccess ? (
        <p role="status">등록된 주소라면 재설정 메일을 보냈습니다. 메일함을 확인하세요.</p>
      ) : (
        <form className={form.form} onSubmit={submit} noValidate aria-busy={mutation.isPending}>
          <div className={form.field}>
            <label htmlFor={id}>이메일</label>
            <input
              id={id}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              className={`${form.input} ${styles.touch}`}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? id + '-error' : undefined}
            />
            {emailError ? (
              <p id={id + '-error'} className={form.fieldError}>
                {emailError}
              </p>
            ) : null}
          </div>
          {mutation.isError ? <AccountError error={mutation.error} /> : null}
          <button className={`${form.submit} ${styles.touch}`} disabled={mutation.isPending}>
            {mutation.isPending ? '요청 중…' : '재설정 메일 받기'}
          </button>
        </form>
      )}
    </AccountFrame>
  );
}
