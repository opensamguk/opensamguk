import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTRPC } from '../trpc';
import { AccountError, AccountFrame } from './AccountParts';
import { VerificationRequest } from './VerifyEmailPage';
import styles from './Account.module.css';

export function AccountPage() {
  const trpc = useTRPC();
  const account = useQuery({ ...trpc.account.get.queryOptions(), staleTime: 0 });
  return (
    <AccountFrame title="내 계정">
      {account.isError ? (
        <AccountError error={account.error} />
      ) : !account.data ? (
        <p role="status">계정을 확인하고 있습니다…</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <dt>이메일</dt>
            <dd>{account.data.email}</dd>
            <dt>인증</dt>
            <dd>{account.data.emailVerified ? '확인됨' : '확인 필요'}</dd>
          </dl>
          {!account.data.emailVerified ? <VerificationRequest email={account.data.email} /> : null}
          <h2>동의 기록</h2>
          {account.data.consentRequired.length > 0 ? (
            <p>
              <Link to="/legal/agree" search={{ next: '/account' }}>
                현재 문서를 확인하고 동의하기
              </Link>
            </p>
          ) : null}
          {account.data.consents.length === 0 ? (
            <p>기록된 동의가 없습니다.</p>
          ) : (
            <ul>
              {account.data.consents.map((consent) => (
                <li key={consent.docType + ':' + consent.version}>
                  {consent.docType === 'TERMS' ? '이용약관' : '개인정보처리방침'} {consent.version} ·{' '}
                  <time dateTime={consent.agreedAt}>{new Date(consent.agreedAt).toLocaleDateString('ko-KR')}</time>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="계정 설정" className={styles.links}>
            <Link to="/legal/terms">이용약관</Link>
            <Link to="/legal/privacy">개인정보처리방침</Link>
            <Link to="/forgot-password">비밀번호 재설정</Link>
            <Link to="/settings/notifications">알림 설정</Link>
          </nav>
        </>
      )}
    </AccountFrame>
  );
}
