import { Link } from '@tanstack/react-router';
import { useEffect, useRef, type Ref } from 'react';
import type { RealtimeStatus } from '../realtime/useWorldEvents';
import { useAuthority, useAuthorityWatch } from './authority';
import { MessagePanel } from './MessagePanel';
import { unreadTotal } from './merge';
import { useUnread } from './queries';
import styles from './MessageDock.module.css';

export const DRAWER_ID = 'message-drawer';

// 위쪽 띠의 메시지 단추. 안 읽음 배지는 볼 수 있는 범위의 안 읽음 수를 더한 값이다.
// GameLayout에 늘 붙어 있으므로 메시지·공지 권한 감시(authority.ts)도 여기서 한 번만 돌린다.
export function MessageButton({
  worldId,
  open,
  onToggle,
  ref,
}: {
  worldId: string;
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  useAuthorityWatch(worldId);
  const authority = useAuthority(worldId);
  const unread = useUnread(worldId);
  const total = unreadTotal(authority.ready ? unread.data : undefined);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.button}
      aria-expanded={open}
      aria-controls={DRAWER_ID}
      aria-label={total > 0 ? `메시지, 안 읽음 ${total}건` : '메시지'}
      data-testid="message-button"
      onClick={onToggle}
    >
      메시지
      {total > 0 ? (
        <span className={styles.badge} data-testid="unread-badge">
          {total > 99 ? '99+' : total}
        </span>
      ) : null}
    </button>
  );
}

// 메인 오른쪽 접이식 메시지 패널. 닫으면 부품을 내리고 초점은 여는 단추로 돌아간다 (GameLayout).
// 작성 칸과 고른 탭은 drafts.ts에 있어 다시 펴도 그대로다.
export function MessageDrawer({ worldId, onClose }: { worldId: string; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <aside
      id={DRAWER_ID}
      ref={ref}
      tabIndex={-1}
      className={styles.drawer}
      aria-labelledby={`${DRAWER_ID}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.head}>
        <h2 id={`${DRAWER_ID}-title`} className={styles.title}>
          메시지
        </h2>
        <Link to="/w/$worldId/messages" params={{ worldId }} className={styles.link}>
          전체 화면
        </Link>
        <button type="button" className={styles.close} onClick={onClose}>
          닫기
        </button>
      </header>
      <div className={styles.body}>
        <MessagePanel worldId={worldId} />
      </div>
    </aside>
  );
}

const STATUS_TEXT: Record<RealtimeStatus, string | null> = {
  connecting: null,
  open: '실시간 연결됨',
  reconnecting: '다시 잇는 중',
};

// 연결 상태를 위쪽 띠에 작게 둔다. 끊긴 동안에도 화면은 그대로 쓸 수 있다.
export function RealtimeStatusText({ status }: { status: RealtimeStatus }) {
  const text = STATUS_TEXT[status];
  return (
    <span className={styles.status} data-realtime={status} data-testid="realtime-status" role="status">
      {text ? (
        <>
          <span className={status === 'open' ? styles.dotOn : styles.dotOff} aria-hidden="true" />
          {text}
        </>
      ) : null}
    </span>
  );
}
