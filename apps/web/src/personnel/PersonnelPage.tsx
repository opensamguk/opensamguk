import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useRef, useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { useHome, useWorldId } from '../game/queries';
import { Portrait } from '../portrait/Portrait';
import { useTRPC } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { DataTable } from '../ui/DataTable';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { CandidatePicker } from './CandidatePicker';
import {
  appointCandidates,
  memberDetails,
  nameLabels,
  traitTags,
  type Candidate,
  type MemberDetail,
} from './candidates';
import { personnelKeys, usePersonnelApi, type PersonnelBoard, type PersonnelMember } from './contract';
import { Notices } from './OfferBox';
import styles from './Personnel.module.css';
import pageStyles from './PersonnelPage.module.css';
import { usePersonnelAction } from './usePersonnelAction';

const KINDS = ['personnel.appoint', 'personnel.dismiss'] as const;
const ACTOR_CHANGED = '장수가 바뀌었습니다. 요청을 보내지 않았습니다. 화면을 다시 확인하세요.';

type DetailsState = 'ready' | 'loading' | 'error';

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

// 같은 국가 장수의 초상·능력치·병력·성격·특기 (INT-25 단계 3). personnel.officers에 없는 값이라 nation.get을 함께 읽는다.
// 못 받아도 인사 칸은 그대로 쓴다. 카드만 능력치 없이 보인다.
function useNationRoster(worldId: string) {
  const trpc = useTRPC();
  const home = useHome(worldId);
  const nation = home.data?.nation ?? null;
  const roster = useQuery({
    ...trpc.nation.get.queryOptions({ worldId, nationId: nation?.id ?? 0 }),
    enabled: nation !== null,
    retry: retryUnlessClientError,
  });
  const generals = roster.data?.generals;
  const details = useMemo(() => (generals ? memberDetails(generals) : undefined), [generals]);
  const state: DetailsState = details
    ? 'ready'
    : roster.isError || home.isError || (home.data !== undefined && nation === null)
      ? 'error'
      : 'loading';
  return { nation, details, state };
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
  const roster = useNationRoster(worldId);
  const members = board.data?.members;
  const action = usePersonnelAction({
    worldId,
    kinds: KINDS,
    nameOf: (id) => members?.find((m) => m.generalId === id)?.name,
  });
  // 누른 화면의 장수가 지금도 이 계정의 장수일 때만 보낸다. 계승 뒤 예전 화면의 임명·해임은 보내지 않는다.
  // 표는 장수 id로 key해 장수가 바뀌면 고르던 임명 후보를 버린다.
  const queryClient = useQueryClient();
  const actorId = board.data?.actorId;
  const sameActor = async () => {
    const fresh = await api.officers({ worldId });
    queryClient.setQueryData(personnelKeys.officers(worldId), fresh);
    return fresh.actorId === actorId ? null : ACTOR_CHANGED;
  };

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>인사부</h1>
        {roster.nation ? <NationBadge name={roster.nation.name} color={roster.nation.color} /> : null}
        <NationNav worldId={worldId} current="personnel" />
      </header>
      <Notices notices={action.notices} />
      {board.data ? (
        <PersonnelBoardView
          key={board.data.actorId}
          board={board.data}
          details={roster.details}
          detailsState={roster.state}
          busyTarget={action.busy ? (action.busyTarget ?? '') : null}
          busyLabel={action.busyLabel}
          onAppoint={(generalId, officerLevel) =>
            void action.submit(
              { kind: 'personnel.appoint', generalId, officerLevel },
              `level-${officerLevel}`,
              sameActor,
            )
          }
          onDismiss={(generalId, officerLevel) =>
            void action.submit({ kind: 'personnel.dismiss', generalId }, `level-${officerLevel}`, sameActor)
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
  // nation.get에서 이은 장수 정보. 없으면 카드와 표가 능력치 없이 보인다.
  details?: ReadonlyMap<number, MemberDetail> | undefined;
  detailsState?: DetailsState;
  // 처리 중인 접수가 있으면 그 대상(level-<직책>). 다시 접속해 되살린 접수는 빈 문자열이다. 없으면 null.
  busyTarget: string | null;
  busyLabel?: string;
  onAppoint: (generalId: number, officerLevel: number) => void;
  onDismiss: (generalId: number, officerLevel: number) => void;
}

export function PersonnelBoardView({
  board,
  details,
  detailsState = details ? 'ready' : 'loading',
  busyTarget,
  busyLabel = '처리 중',
  onAppoint,
  onDismiss,
}: BoardProps) {
  const labels = useMemo(() => nameLabels(board.members), [board.members]);
  const byId = useMemo(() => new Map(board.members.map((m) => [m.generalId, m])), [board.members]);
  const candidates = useMemo(() => appointCandidates(board, details, labels), [board, details, labels]);
  // 후보 목록은 한 번에 한 직책만 펼친다.
  const [openLevel, setOpenLevel] = useState<number | null>(null);
  const label = (m: PersonnelMember) => labels.get(m.generalId) ?? m.name;
  return (
    <>
      <section className={styles.section} aria-labelledby="levels-title">
        <h2 id="levels-title">직책 바꾸기</h2>
        <table className={`${styles.levels} ${pageStyles.levels}`}>
          <thead>
            <tr>
              <th scope="col">직책</th>
              <th scope="col">앉은 장수</th>
              <th scope="col">바꾸기</th>
            </tr>
          </thead>
          <tbody>
            {board.levels.map((level) => (
              <LevelRows
                key={level.officerLevel}
                level={level}
                holder={level.holderId === null ? null : (byId.get(level.holderId) ?? level.holderId)}
                holderLabel={level.holderId === null ? '' : (labels.get(level.holderId) ?? `장수 ${level.holderId}`)}
                holderDetail={level.holderId === null ? undefined : details?.get(level.holderId)}
                appoint={board.appoint}
                candidates={candidates}
                detailsState={detailsState}
                open={openLevel === level.officerLevel}
                onOpen={(open) => setOpenLevel(open ? level.officerLevel : null)}
                busy={busyTarget === null ? null : busyTarget === `level-${level.officerLevel}`}
                busyLabel={busyLabel}
                onAppoint={onAppoint}
                onDismiss={onDismiss}
              />
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
                sortValue: (m) => label(m),
                render: (m) => (
                  <>
                    {label(m)} {m.isHuman ? <Tag tone="accent">사람</Tag> : <Tag tone="muted">NPC</Tag>}
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
              {
                key: 'traits',
                label: '성격·특기',
                render: (m) => (
                  <span className={pageStyles.traits}>
                    {traitTags(details?.get(m.generalId)).map((trait) => (
                      <Tag key={trait} tone="muted">
                        {trait}
                      </Tag>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        )}
      </section>
    </>
  );
}

type Level = PersonnelBoard['levels'][number];

function LevelRows({
  level,
  holder,
  holderLabel,
  holderDetail,
  appoint,
  candidates,
  detailsState,
  open,
  onOpen,
  busy,
  busyLabel,
  onAppoint,
  onDismiss,
}: {
  level: Level;
  // 앉은 장수. 소속 장수 목록에 없으면 id만 온다.
  holder: PersonnelMember | number | null;
  holderLabel: string;
  holderDetail: MemberDetail | undefined;
  appoint: PersonnelBoard['appoint'];
  candidates: readonly Candidate[];
  detailsState: DetailsState;
  open: boolean;
  onOpen: (open: boolean) => void;
  // null: 처리 중인 접수 없음. true: 이 직책을 처리 중. false: 다른 접수를 처리 중.
  busy: boolean | null;
  busyLabel: string;
  onAppoint: (generalId: number, officerLevel: number) => void;
  onDismiss: (generalId: number, officerLevel: number) => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const pickerId = useId();
  // 카드를 고르면 목록을 닫고 「임명」으로 초점을 옮긴다.
  const focusAppoint = useRef(false);
  // 고른 장수가 새로 받은 목록에 없으면(다른 직책에 앉았거나 떠남) 고르지 않은 것으로 본다.
  const picked = chosen === null ? undefined : candidates.find((c) => c.member.generalId === chosen);
  const canPick = appoint.ok && busy === null && level.holderId === null;
  return (
    <>
      <tr data-level={level.officerLevel}>
        <td>{level.title}</td>
        <td>
          {holder === null ? (
            <span className={styles.muted}>빈 자리</span>
          ) : (
            <span className={pageStyles.holder}>
              <span className={pageStyles.holderFace} aria-hidden="true">
                <Portrait
                  id={holderDetail?.portraitId ?? null}
                  name={holderLabel}
                  variant="icon"
                  shape="round"
                  className={pageStyles.holderIcon}
                />
              </span>
              <span className={pageStyles.holderText}>
                <span>{holderLabel}</span>
                {typeof holder === 'object' ? <span className={pageStyles.holderCity}>{holder.city.name}</span> : null}
              </span>
            </span>
          )}
        </td>
        <td>
          {!appoint.ok ? (
            // 권한은 서버가 준 appoint로만 판단한다. 군주가 아니면 칸을 열지 않고 이유를 보인다.
            <DisabledReason reason={appoint.reason}>{level.holderId === null ? '임명' : '해임'}</DisabledReason>
          ) : busy !== null ? (
            <span className={styles.controls}>
              <DisabledReason
                reason={busyLabel === '보내는 중' ? '요청을 보내는 중입니다.' : '요청을 처리하는 중입니다.'}
              >
                {level.holderId === null ? '임명' : '해임'}
              </DisabledReason>
              {busy ? (
                <span className={styles.busy} role="status">
                  {busyLabel}
                </span>
              ) : null}
            </span>
          ) : level.holderId !== null ? (
            <button
              type="button"
              className={`${styles.secondary} ${styles.danger} ${pageStyles.tap}`}
              onClick={() => onDismiss(level.holderId!, level.officerLevel)}
            >
              해임
            </button>
          ) : (
            <span className={styles.controls}>
              <button
                type="button"
                className={`${styles.secondary} ${pageStyles.tap}`}
                aria-label={`${level.title} 임명할 장수 고르기`}
                aria-expanded={open}
                aria-controls={open ? pickerId : undefined}
                onClick={() => onOpen(!open)}
              >
                장수 고르기
              </button>
              {picked ? (
                <>
                  <span className={pageStyles.chosen}>
                    고른 장수 <strong>{picked.label}</strong>
                  </span>
                  <button
                    type="button"
                    ref={(button) => {
                      if (button && focusAppoint.current) {
                        focusAppoint.current = false;
                        button.focus();
                      }
                    }}
                    className={`${styles.primary} ${pageStyles.tap}`}
                    onClick={() => onAppoint(picked.member.generalId, level.officerLevel)}
                  >
                    임명
                  </button>
                </>
              ) : (
                <DisabledReason reason="임명할 장수를 고르세요.">임명</DisabledReason>
              )}
            </span>
          )}
        </td>
      </tr>
      {canPick && open ? (
        <tr className={pageStyles.pickerRow}>
          <td colSpan={3}>
            <CandidatePicker
              id={pickerId}
              title={level.title}
              candidates={candidates}
              chosen={picked ? picked.member.generalId : null}
              detailsState={detailsState}
              onPick={(generalId) => {
                focusAppoint.current = true;
                setChosen(generalId);
                onOpen(false);
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
