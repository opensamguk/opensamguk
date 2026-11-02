import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import styles from './Account.module.css';

export function WithdrawalActions({
  stamp,
  onWithdraw,
}: {
  stamp: string;
  onWithdraw(password: string, stamp: string): Promise<void>;
}) {
  const [password, setPassword] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || password.length < 1 || password.length > 128) return;
    const value = password;
    setPassword('');
    setConfirmed(false);
    void onWithdraw(value, stamp);
  }
  return (
    <form onSubmit={submit} className={styles.withdrawal}>
      <p>탈퇴하면 로그인과 계정 복구를 할 수 없습니다. 처리방침에 따라 게임 기록 등 일부 자료를 보존합니다.</p>
      <p>
        <Link to="/legal/privacy">개인정보처리방침의 처리·보존 기준 확인</Link>
      </p>
      <label htmlFor="withdraw-password">현재 비밀번호</label>
      <input
        id="withdraw-password"
        type="password"
        autoComplete="current-password"
        minLength={1}
        maxLength={128}
        required
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setConfirmed(false);
        }}
      />
      <label className={styles.confirm}>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>현재 계정의 탈퇴와 복구 불가를 확인했습니다.</span>
      </label>
      <button
        className={`${styles.touch} ${styles.danger}`}
        type="submit"
        disabled={!confirmed || password.length < 1 || password.length > 128}
      >
        계정 탈퇴 확정
      </button>
    </form>
  );
}
