import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useWorldId } from '../game/queries';
import { errorCode, serverMessage } from '../turns/apiError';
import { DataTable } from '../ui/DataTable';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { personnelKeys, usePersonnelApi, type PersonnelBoard, type PersonnelMember } from './contract';
import { Notices } from './OfferBox';
import styles from './Personnel.module.css';
import { usePersonnelAction } from './usePersonnelAction';

const KINDS = ['personnel.appoint', 'personnel.dismiss'] as const;

// 국가 메뉴의 두 화면을 잇는 띠.
export function NationNav({ worldId, current }: { worldId: string; current: 'personnel' | 'turns' }) {
  return (
    <nav className={styles.subnav} aria-label="국가 메뉴">
      <Link
        to="/w/$worldId/nation/personnel"
        params={{ worldId }}
        aria-current={current === 'personnel' ? 'page' : undefined}
      >
        인사부
      </Link>
      <Link to="/w/$worldId/nation/turns" params={{ worldId }} aria-current={current === 'turns' ? 'page' : undefined}>
        국가 예턴
      </Link>
    </nav>
  );
}

// 조회를 서버가 거부하면(재야, 인사 기능 이전 월드, 권한 없음) 그 이유를 그대로 보인다. 연결 실패는 다시 시도.
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = errorCode(error) !== undefined ? serverMessage(error) : undefined;
  if (message) return <EmptyState title={message} />;
  return <ErrorState title="불러오지 못했습니다" onRetry={onRetry} />;
}

// /w/:worldId/nation/personnel. 소속 장수 표와 군주의 임명·해임 (T2-06, AC-M2-05).
export function PersonnelPage() {
  const worldId = useWorldId();
  const api = usePersonnelApi();
  const board = useQuery({
    queryKey: personnelKeys.officers(worldId),
    queryFn: () => api.officers({ worldId }),
    retry: false,
  });
  const members = board.data?.members;
  const action = usePersonnelAction({
    worldId,
    kinds: KINDS,
    nameOf: (id) => members?.find((m) => m.generalId === id)?.name,
  });

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>인사부</h1>
        <NationNav worldId={worldId} current="personnel" />
      </header>
      <Notices notices={action.notices} />
      {board.data ? (
        <PersonnelBoardView
          board={board.data}
          busyTarget={action.busy ? (action.busyTarget ?? '') : null}
          onAppoint={(generalId, officerLevel) =>
            void action.submit({ kind: 'personnel.appoint', generalId, officerLevel }, `level-${officerLevel}`)
          }
          onDismiss={(generalId, officerLevel) =>
            void action.submit({ kind: 'personnel.dismiss', generalId }, `level-${officerLevel}`)
          }
        />
      ) : board.isError ? (
        <LoadError error={board.error} onRetry={() => void board.refetch()} />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}

interface BoardProps {
  board: PersonnelBoard;
  // 처리 중인 접수가 있으면 그 대상(level-<직책>). 다시 접속해 되살린 접수는 빈 문자열이다. 없으면 null.
  busyTarget: string | null;
  onAppoint: (generalId: number, officerLevel: number) => void;
  onDismiss: (generalId: number, officerLevel: number) => void;
}

export function PersonnelBoardView({ board, busyTarget, onAppoint, onDismiss }: BoardProps) {
  const nameOf = (id: number) => board.members.find((m) => m.generalId === id)?.name ?? `장수 ${id}`;
  const holders = new Set(board.levels.map((level) => level.holderId).filter((id) => id !== null));
  // 직책이 없는 장수만 후보로 둔다. 최종 판단은 서버가 한다.
  const candidates = board.members.filter((m) => !holders.has(m.generalId) && m.officerLevel <= 1);
  return (
    <>
      <section className={styles.section} aria-labelledby="levels-title">
        <h2 id="levels-title">직책 바꾸기</h2>
        <table className={styles.levels}>
          <thead>
            <tr>
              <th scope="col">직책</th>
              <th scope="col">앉은 장수</th>
              <th scope="col">바꾸기</th>
            </tr>
          </thead>
          <tbody>
            {board.levels.map((level) => (
              <tr key={level.officerLevel} data-level={level.officerLevel}>
                <td>{level.title}</td>
                <td>
                  {level.holderId === null ? <span className={styles.muted}>빈 자리</span> : nameOf(level.holderId)}
                </td>
                <td>
                  <LevelControl
                    level={level}
                    appoint={board.appoint}
                    candidates={candidates}
                    busy={busyTarget === null ? null : busyTarget === `level-${level.officerLevel}`}
                    onAppoint={onAppoint}
                    onDismiss={onDismiss}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className={styles.section} aria-labelledby="members-title">
        <h2 id="members-title">소속 장수</h2>
        {board.members.length === 0 ? (
          <EmptyState title="소속 장수가 없습니다" />
        ) : (
          <DataTable<PersonnelMember>
            rows={board.members}
            rowKey={(m) => m.generalId}
            columns={[
              {
                key: 'name',
                label: '이름',
                sortValue: (m) => m.name,
                render: (m) => (
                  <>
                    {m.name} {m.isHuman ? <Tag tone="accent">사람</Tag> : <Tag tone="muted">NPC</Tag>}
                  </>
                ),
              },
              { key: 'title', label: '직책', sortValue: (m) => m.officerLevel, render: (m) => m.title },
              { key: 'city', label: '도시', sortValue: (m) => m.city.name, render: (m) => m.city.name },
              {
                key: 'dedication',
                label: '공헌',
                numeric: true,
                sortValue: (m) => m.dedication,
                render: (m) => m.dedication.toLocaleString('ko-KR'),
              },
            ]}
          />
        )}
      </section>
    </>
  );
}

function LevelControl({
  level,
  appoint,
  candidates,
  busy,
  onAppoint,
  onDismiss,
}: {
  level: PersonnelBoard['levels'][number];
  appoint: PersonnelBoard['appoint'];
  candidates: PersonnelMember[];
  // null: 처리 중인 접수 없음. true: 이 직책을 처리 중. false: 다른 접수를 처리 중.
  busy: boolean | null;
  onAppoint: (generalId: number, officerLevel: number) => void;
  onDismiss: (generalId: number, officerLevel: number) => void;
}) {
  const [chosen, setChosen] = useState('');
  const label = level.holderId === null ? '임명' : '해임';
  // 권한은 서버가 준 appoint로만 판단한다. 군주가 아니면 칸을 열지 않고 이유를 보인다.
  if (!appoint.ok) return <DisabledReason reason={appoint.reason}>{label}</DisabledReason>;
  if (busy !== null)
    return (
      <span className={styles.controls}>
        <DisabledReason reason="요청을 처리하는 중입니다.">{label}</DisabledReason>
        {busy ? (
          <span className={styles.busy} role="status">
            처리 중
          </span>
        ) : null}
      </span>
    );
  if (level.holderId !== null) {
    const holderId = level.holderId;
    return (
      <button
        type="button"
        className={`${styles.secondary} ${styles.danger}`}
        onClick={() => onDismiss(holderId, level.officerLevel)}
      >
        해임
      </button>
    );
  }
  const generalId = Number(chosen);
  return (
    <span className={styles.controls}>
      <label>
        <span className={styles.muted}>임명할 장수 </span>
        <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label={`${level.title} 임명할 장수`}>
          <option value="">고르세요</option>
          {candidates.map((m) => (
            <option key={m.generalId} value={String(m.generalId)}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {chosen === '' ? (
        <DisabledReason reason="임명할 장수를 고르세요.">임명</DisabledReason>
      ) : (
        <button type="button" className={styles.primary} onClick={() => onAppoint(generalId, level.officerLevel)}>
          임명
        </button>
      )}
    </span>
  );
}
