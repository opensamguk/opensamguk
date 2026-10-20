import { useId, useState, type ReactNode } from 'react';
import styles from './DisabledReason.module.css';

// 못 쓰는 버튼은 숨기지 않고 점선으로 두며, 누르면 이유를 보여 준다 (v1 원칙).
// 가능 여부와 이유는 서버가 정한 값을 받는다.
// aria-disabled는 쓰지 않는다: 이 버튼은 "이유 보기"라는 실제 동작을 하므로 눌러져야 한다.
// 대신 접근 가능한 이름에 "(사용 불가)"를 붙인다.
export function DisabledReason({ children, reason }: { children: ReactNode; reason: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        data-unavailable="true"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
        <span className={styles.srOnly}> (사용 불가)</span>
      </button>
      {open ? (
        <span id={id} role="note" className={styles.reason}>
          {reason}
        </span>
      ) : null}
    </span>
  );
}
