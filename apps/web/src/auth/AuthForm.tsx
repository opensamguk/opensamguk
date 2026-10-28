import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTRPC } from '../trpc';
import { ErrorState } from '../ui/States';
import { describeFailure, validateCredentials, type FieldErrors } from './credentials';
import styles from './AuthForm.module.css';
import { accountNext, needsEmailVerification } from '../account/access';

type Mode = 'login' | 'signup';

const TEXT = {
  login: { submit: '로그인', pending: '로그인 중…', password: 'current-password' },
  signup: { submit: '가입하기', pending: '가입 중…', password: 'new-password' },
} as const;

// 로그인과 가입이 같은 칸(이메일·비밀번호)을 쓰므로 한 부품으로 둔다. 문구와 API만 다르다.
export function AuthForm({ mode, next }: { mode: Mode; next?: string | undefined }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const options = mode === 'login' ? trpc.auth.login.mutationOptions() : trpc.auth.signup.mutationOptions();
  const mutation = useMutation({
    ...options,
    onSuccess: async ({ user }) => {
      // 이전 사용자의 캐시가 남지 않게 비우고, 가드가 다시 묻지 않도록 로그인 결과를 바로 넣는다.
      queryClient.clear();
      queryClient.setQueryData(trpc.auth.me.queryKey(), { user });
      try {
        const account = await queryClient.fetchQuery({ ...trpc.account.get.queryOptions(), staleTime: 0 });
        if (needsEmailVerification(account)) {
          await navigate({ to: '/verify-email', search: { next: accountNext(next) ?? '/lobby' }, replace: true });
          return;
        }
      } catch {
        // 가입·로그인은 이미 성공했다. 입력을 다시 보내지 않고 가드의 조회 재시도로 이어 간다.
        await navigate({ to: '/', search: { next: accountNext(next) ?? '/lobby' }, replace: true });
        return;
      }
      // 안전한 next가 없으면 로비로 간다 (T2-04).
      await navigate({ href: accountNext(next) ?? '/lobby', replace: true });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    const errors = validateCredentials(email, password);
    setFieldErrors(errors);
    if (errors.email || errors.password) return;
    mutation.mutate({ email: email.trim(), password });
  }

  const failure = mutation.isError ? describeFailure(mutation.error) : null;
  const text = TEXT[mode];

  return (
    <form ref={formRef} className={styles.form} onSubmit={onSubmit} noValidate aria-busy={mutation.isPending}>
      <div className={styles.field}>
        <label htmlFor={`${id}-email`}>이메일</label>
        <input
          id={`${id}-email`}
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? `${id}-email-error` : undefined}
        />
        {fieldErrors.email ? (
          <p id={`${id}-email-error`} className={styles.fieldError}>
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${id}-password`}>비밀번호</label>
        <div className={styles.passwordRow}>
          <input
            id={`${id}-password`}
            className={styles.input}
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete={text.password}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={`${id}-password-hint${fieldErrors.password ? ` ${id}-password-error` : ''}`}
          />
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={showPassword}
            aria-controls={`${id}-password`}
            onClick={() => setShowPassword((shown) => !shown)}
          >
            {showPassword ? '숨기기' : '보이기'}
          </button>
        </div>
        <p id={`${id}-password-hint`} className={styles.hint}>
          10~128자
        </p>
        {fieldErrors.password ? (
          <p id={`${id}-password-error`} className={styles.fieldError}>
            {fieldErrors.password}
          </p>
        ) : null}
      </div>

      {failure?.kind === 'message' ? (
        <p className={styles.formError} role="alert">
          {failure.text}
        </p>
      ) : null}
      {failure?.kind === 'retry' ? (
        <ErrorState
          title="서버에 연결하지 못했습니다"
          // 실패 뒤 고친 입력을 그대로 보내도록 지금 폼 값으로 다시 제출한다 (T1-14 Codex 리뷰 2).
          onRetry={() => formRef.current?.requestSubmit()}
        />
      ) : null}

      <button type="submit" className={styles.submit} disabled={mutation.isPending}>
        {mutation.isPending ? text.pending : text.submit}
      </button>
    </form>
  );
}
