import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { formatYearMonth, personalLogDate } from '../game/gameDate';
import { useWorldMap, useWorldSummary } from '../game/queries';
import { DataTable, type Column } from '../ui/DataTable';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import styles from './governance.module.css';
import {
  censureTargets,
  describeAction,
  formatCount,
  generalName,
  legitimacyOf,
  nationName,
  OFFICE_LABEL,
  OFFICE_POWER,
  officeByRef,
  offerCheck,
  offerSources,
  percent,
  realm,
  realmScope,
  splitOffers,
  vassalActions,
  viewerOffice,
  type GovernanceBoard,
  type GovernanceInput,
  type GovernanceMovementRow,
  type GovernanceOffice,
  type GovernanceOfferRow,
  type GovernanceVassalRow,
  type GovernanceView,
  type OfferDraft,
} from './governanceModel';
import { useGovernanceBoard } from './useGovernanceBoard';

// 국가 정보 칸 아래의 황실 칸 (T4-94, AC-P2-31). 황위·조정·봉신·제안·기록을 governance.get 값으로만 보인다.
// 모든 행동은 확인 대화상자를 거쳐 명시 요청 한 건으로 보낸다. 명령 카드·예턴에는 넣지 않는다.
// world.summary에 governanceEnabled가 있을 때만 조회한다. 없으면 아무것도 그리지 않고 요청도 하지 않는다.
export function GovernancePanel({ worldId }: { worldId: string }) {
  const data = useWorldSummary(worldId).data;
  const enabled = data !== undefined && 'governanceEnabled' in data && data.governanceEnabled === true;
  return enabled ? <GovernanceBoardView key={worldId} worldId={worldId} /> : null;
}

type When = (tick: number) => string;
type Ask = (payload: GovernanceInput, event: MouseEvent<HTMLElement>) => void;
type Ctx = {
  view: GovernanceView;
  movements: readonly GovernanceMovementRow[];
  tick: number;
  when: When;
  cityName: (key: number) => string;
  lock: string | null;
  busy: boolean;
  ask: Ask;
};
type Confirm = {
  payload: GovernanceInput;
  title: string;
  ok: string;
  danger: boolean;
  lines: string[];
  // 연 계정·세션·장수. 보기가 지워지거나 계정·장수가 바뀌면 이 대화상자는 다시 보이지도, 보내지지도 않는다.
  userId: string;
  session: number;
  generalId: number | null;
};

const TABS = [
  ['crown', '황위'],
  ['court', '조정'],
  ['realm', '봉신'],
  ['offers', '제안'],
  ['history', '기록'],
] as const;
type Tab = (typeof TABS)[number][0];

function readOnlyReason(board: GovernanceBoard): string {
  if (board.status !== 'RUNNING') return '진행 중인 월드가 아니라 황실 정보는 볼 수만 있습니다.';
  if (board.settling)
    return '월 정산을 처리하는 중이라 지금은 볼 수만 있습니다. 정산이 끝나면 다시 요청할 수 있습니다.';
  if (board.view.enabled && board.view.viewerGeneralId === null) return '장수가 있어야 황실 요청을 보낼 수 있습니다.';
  return '이 월드의 이용이 제한된 동안에는 볼 수만 있습니다.';
}

function GovernanceBoardView({ worldId }: { worldId: string }) {
  const board = useGovernanceBoard(worldId);
  const summary = useWorldSummary(worldId);
  const map = useWorldMap(worldId);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // 탭은 적용 뒤 폼을 새로 만들 때도 그대로 둔다.
  const [tab, setTab] = useState<Tab>('crown');
  const opener = useRef<HTMLElement | null>(null);
  const { view: state, notice } = board;
  const viewer = state?.board.view.enabled ? state.board.view.viewerGeneralId : null;
  const live =
    confirm && confirm.userId === state?.userId && confirm.session === board.session && confirm.generalId === viewer
      ? confirm
      : null;
  useEffect(() => {
    if (!confirm || live) return;
    // 무효가 된 대화상자는 버린다. 초점이 사라진 대화상자에 남지 않게 제목으로 옮긴다.
    setConfirm(null);
    opener.current = null;
    heading.current?.focus();
  }, [confirm, live]);
  if (board.off) return null;
  const view = state?.board.view.enabled ? state.board.view : null;
  const clock = summary.data;
  const when: When = (tick) => (clock ? formatYearMonth(personalLogDate(tick, clock)) : '—');
  const cityName = (key: number) => map.data?.cities.find((city) => city.key === key)?.name ?? `거점 ${key}`;
  const lock = !state
    ? '황실 정보를 확인하는 중입니다.'
    : state.pending
      ? '앞 황실 요청의 결과를 기다리는 중입니다. 상태를 확인한 뒤 보내세요.'
      : board.stale
        ? '보이는 값이 오래됐을 수 있습니다. 새로 확인한 뒤 보내세요.'
        : !board.canSubmit
          ? readOnlyReason(state.board)
          : null;
  const ask: Ask = (payload, event) => {
    if (!state || !view || lock || board.busy) return;
    opener.current = event.currentTarget;
    setConfirm({
      payload,
      ...confirmText(view, payload, cityName),
      userId: state.userId,
      session: board.session,
      generalId: view.viewerGeneralId,
    });
  };
  const close = (send: boolean) => {
    const current = live;
    setConfirm(null);
    if (send && current && !lock) board.submit(current.payload, current);
    const target = opener.current;
    opener.current = null;
    requestAnimationFrame(() => (target?.isConnected ? target : heading.current)?.focus());
  };

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1} className={styles.title}>
        황실
      </h3>
      {notice ? (
        <p
          className={notice.tone === 'error' ? styles.error : notice.tone === 'ok' ? styles.ok : styles.info}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}
      {!state || !view ? (
        board.busy ? (
          <LoadingState>황실 정보를 확인하는 중</LoadingState>
        ) : (
          <div className={styles.row}>
            {board.retryWait ? <p role="status">{board.retryWait}초 뒤에 다시 확인하세요.</p> : null}
            <button
              type="button"
              className={styles.secondary}
              disabled={board.retryWait > 0}
              onClick={() => void board.load()}
            >
              다시 확인
            </button>
          </div>
        )
      ) : (
        <>
          {board.stale ? (
            <div className={styles.row}>
              <p className={styles.note}>
                보이는 값이 오래됐을 수 있습니다. 새로 확인하기 전에는 새 요청을 보내지 않습니다.
              </p>
              <button
                type="button"
                className={styles.secondary}
                disabled={board.busy}
                onClick={() => void board.load()}
              >
                새로 확인
              </button>
            </div>
          ) : null}
          {state.pending ? (
            <div className={styles.status} role="status" aria-live="polite">
              <p>
                <strong>요청 처리 대기</strong> · {describeAction(view, state.pending.payload)}
              </p>
              <p className={styles.note}>
                {!board.unconfirmed
                  ? '접수한 요청을 처리하고 있습니다. 결과가 나올 때까지 다른 황실 요청은 기다려 주세요.'
                  : board.oldActor
                    ? '이 요청의 접수 기록을 찾지 못했습니다. 장수가 이미 바뀌어, 이전 장수 명의 요청은 서버가 거부하므로 앞으로도 처리되지 않습니다. 기록 지우기를 누르면 지금 장수와 접수 기록을 한 번 더 확인한 뒤 이 탭의 기록만 지웁니다. 다시 보내지 않습니다.'
                    : '이 요청의 접수 기록을 아직 찾지 못했습니다. 보내던 요청이 늦게 접수될 수도 있습니다. 같은 요청을 그대로 다시 접수하면 서버가 같은 번호로 한 번만 받습니다. 결과를 받기 전에는 새 요청을 만들지 않습니다.'}
              </p>
              {board.oldActor && state.pending.generalId !== undefined ? (
                <p className={styles.note}>
                  이 요청은 이전 장수({generalName(view, state.pending.generalId)}) 명의로 보냈습니다. 같은 번호로
                  결과만 확인합니다.
                </p>
              ) : null}
              {board.unconfirmed && !board.oldActor && !board.canSubmit ? (
                <p className={styles.note}>지금은 다시 접수할 수 없어 같은 요청의 상태만 확인할 수 있습니다.</p>
              ) : null}
              <div className={styles.row}>
                <button type="button" className={styles.secondary} disabled={board.busy} onClick={board.recheck}>
                  같은 요청 상태 확인
                </button>
                {board.unconfirmed && !board.oldActor && board.canSubmit ? (
                  <button type="button" className={styles.secondary} disabled={board.busy} onClick={board.resubmit}>
                    같은 요청 다시 접수
                  </button>
                ) : null}
                {board.unconfirmed && board.oldActor ? (
                  <button type="button" className={styles.secondary} disabled={board.busy} onClick={board.forgetOld}>
                    이전 장수 요청 기록 지우기
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {!board.canSubmit ? (
            <p className={styles.note} role="note">
              {readOnlyReason(state.board)}
            </p>
          ) : null}
          <Body
            key={`${state.userId}:${board.formEpoch}`}
            ctx={{
              view,
              movements: state.board.movements,
              tick: state.board.tick,
              when,
              cityName,
              lock,
              busy: board.busy,
              ask,
            }}
            tab={tab}
            setTab={setTab}
          />
        </>
      )}
      {live ? <ConfirmDialog confirm={live} onClose={close} /> : null}
    </section>
  );
}

function Body({ ctx, tab, setTab }: { ctx: Ctx; tab: Tab; setTab: (tab: Tab) => void }) {
  const id = useId();
  const received = splitOffers(ctx.view).received.length;
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(([key]) => key === tab);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next]![0]);
    document.getElementById(`${id}-tab-${TABS[next]![0]}`)?.focus();
  };
  return (
    <div className={styles.body}>
      <Hud ctx={ctx} />
      <div className={styles.tabs} role="tablist" aria-label="황실 보기">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${id}-panel`}
            tabIndex={tab === key ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(key)}
            onKeyDown={onTabKey}
          >
            {label}
            {key === 'offers' && received ? (
              <>
                {' '}
                <span className={styles.count}>{formatCount(received)}</span>
                <span className={styles.srOnly}>건 응답 대기</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className={styles.tabPanel}>
        {tab === 'crown' ? (
          <CrownTab ctx={ctx} />
        ) : tab === 'court' ? (
          <CourtTab ctx={ctx} />
        ) : tab === 'realm' ? (
          <RealmTab ctx={ctx} />
        ) : tab === 'offers' ? (
          <OffersTab ctx={ctx} />
        ) : (
          <HistoryTab ctx={ctx} />
        )}
      </div>
    </div>
  );
}

// 사용할 수 있으면 실제 단추, 막혀 있으면 점선 단추(누르면 이유)를 그린다.
function Action({
  ctx,
  label,
  payload,
  reason = null,
  tone = 'primary',
}: {
  ctx: Ctx;
  label: string;
  payload: GovernanceInput | null;
  reason?: string | null;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  const why = ctx.lock ?? reason;
  if (why || !payload) return <DisabledReason reason={why ?? '입력을 확인하세요.'}>{label}</DisabledReason>;
  return (
    <button type="button" className={styles[tone]} disabled={ctx.busy} onClick={(event) => ctx.ask(payload, event)}>
      {label}
    </button>
  );
}

function Nation({ view, id }: { view: GovernanceView; id: number | null }) {
  if (id === null) return <Tag tone="muted">없음</Tag>;
  const row = view.nations.find((nation) => nation.id === id);
  return <NationBadge name={row?.name ?? `국가 ${id}`} color={row?.color ?? null} />;
}

function Meter({ value, at, label }: { value: number; at: number; label: string }) {
  return (
    <div className={styles.meter} role="img" aria-label={`${label} 정통성 ${value} / 100, 즉위 기준 ${at}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      <b style={{ left: `${Math.max(0, Math.min(100, at))}%` }} />
    </div>
  );
}

function Hud({ ctx }: { ctx: Ctx }) {
  const { view, when, cityName } = ctx;
  const own = view.ownNationId;
  const legit = legitimacyOf(view, own);
  const ascend = view.ascend;
  return (
    <dl className={styles.hud} aria-label="황실 요약">
      <div>
        <dt>황제</dt>
        <dd>
          {view.throne.emperorGeneralId === null ? (
            <Tag tone="muted">공석</Tag>
          ) : (
            <>
              <b>{generalName(view, view.throne.emperorGeneralId)}</b>{' '}
              <Nation view={view} id={view.throne.emperorNationId} />
            </>
          )}
        </dd>
        <dd className={styles.note}>
          {view.throne.emperorGeneralId === null
            ? `천자 소재 거점 소유국 군주가 정통성 ${view.limits.ascendAt} 이상이면 즉위할 수 있습니다.`
            : `${when(view.throne.sinceTick)} 즉위`}
        </dd>
      </div>
      <div>
        <dt>천자 소재 거점</dt>
        <dd>
          <b>{cityName(view.seat.cityKey)}</b> · 소유 <Nation view={view} id={view.seat.nationId} />
        </dd>
        <dd className={styles.note}>거점을 잃은 황제는 폐위됩니다.</dd>
      </div>
      <div>
        <dt>내 국가 정통성{own !== null ? ` · ${nationName(view, own)}` : ''}</dt>
        {legit === null ? (
          <dd className={styles.note}>소속 국가가 없습니다.</dd>
        ) : (
          <>
            <dd>
              <Meter value={legit} at={view.limits.ascendAt} label={nationName(view, own)} />
            </dd>
            <dd className={styles.note}>
              {legit} / 100 · 즉위 기준 {view.limits.ascendAt}
            </dd>
          </>
        )}
      </div>
      <div>
        <dt>즉위</dt>
        <dd>
          {view.roles.emperor
            ? `재위 중 · ${when(view.throne.sinceTick)}부터`
            : ascend.allowed
              ? '조건을 모두 채웠습니다. 직접 요청해야 즉위합니다.'
              : ascend.message}
        </dd>
        {!view.roles.emperor && ascend.allowed ? (
          <dd>
            <Action ctx={ctx} label="즉위 요청" payload={{ type: 'throne.ascend' }} />
          </dd>
        ) : null}
      </div>
    </dl>
  );
}

function CrownTab({ ctx }: { ctx: Ctx }) {
  const { view, when, cityName } = ctx;
  const tree = realm(view);
  const seat = cityName(view.seat.cityKey);
  return (
    <>
      <div className={styles.cards}>
        <article className={view.roles.emperor ? `${styles.card} ${styles.mine}` : styles.card}>
          <h4>
            황위 {view.throne.emperorGeneralId === null ? <Tag tone="muted">공석</Tag> : <Tag tone="accent">재위</Tag>}
            {view.roles.emperor ? <Tag tone="info">나</Tag> : null}
          </h4>
          {view.throne.emperorGeneralId === null ? (
            <p className={styles.note}>
              황제가 없습니다. 거점 {seat} 소유국의 군주가 조건을 채우면 즉위를 요청할 수 있습니다.
            </p>
          ) : (
            <dl className={styles.preview}>
              <dt>황제</dt>
              <dd>
                {generalName(view, view.throne.emperorGeneralId)}{' '}
                <Nation view={view} id={view.throne.emperorNationId} />
              </dd>
              <dt>즉위</dt>
              <dd>{when(view.throne.sinceTick)}</dd>
              <dt>거점</dt>
              <dd>
                {seat} ({nationName(view, view.seat.nationId)} 소유)
              </dd>
            </dl>
          )}
          <details className={styles.disc}>
            <summary>폐위·정리 조건</summary>
            <ul>
              <li>황제 장수가 없어지거나 군주가 아니게 됨</li>
              <li>황제국 멸망, 거점 {seat} 상실, 황제국의 봉신화</li>
              <li>폐위·퇴위 때 세 직위와 조정 제안, 황실 명의 제안도 함께 정리</li>
            </ul>
          </details>
          {view.roles.emperor ? (
            <div className={styles.row}>
              <Action ctx={ctx} label="퇴위 요청" payload={{ type: 'throne.abdicate' }} tone="danger" />
            </div>
          ) : null}
        </article>
        {view.roles.emperor ? null : (
          <article className={styles.card}>
            <h4>즉위</h4>
            {view.ascend.allowed ? (
              <p>조건을 모두 채웠습니다.</p>
            ) : (
              <ul className={styles.reasons} aria-label="지금 즉위할 수 없는 이유">
                <li>{view.ascend.message}</li>
              </ul>
            )}
            <p className={styles.note}>
              즉위하려면 황위가 비어 있어야 합니다. 거점 {seat}을 소유한 국가의 군주여야 합니다. 그 국가는 봉신국이
              아니어야 합니다. 그 국가의 정통성은 {view.limits.ascendAt} 이상이어야 합니다. 사람 군주는 자동으로
              즉위하지 않으며 처리할 때 다시 판정합니다.
            </p>
            <div className={styles.row}>
              <Action
                ctx={ctx}
                label="즉위 요청"
                payload={{ type: 'throne.ascend' }}
                reason={view.ascend.allowed ? null : view.ascend.message}
              />
            </div>
          </article>
        )}
      </div>
      <h4>국가별 정통성 (공개)</h4>
      <ul className={styles.legit}>
        {view.legitimacy.map((row) => {
          const over = tree.parents.get(row.nationId);
          return (
            <li key={row.nationId}>
              <Nation view={view} id={row.nationId} />
              <Meter value={row.value} at={view.limits.ascendAt} label={nationName(view, row.nationId)} />
              <span className={styles.value}>{row.value}</span>
              {over !== undefined ? <span className={styles.note}>{nationName(view, over)}의 봉신</span> : null}
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>범위 0~100. 붉은 눈금이 즉위 기준 {view.limits.ascendAt}입니다.</p>
    </>
  );
}

function CourtTab({ ctx }: { ctx: Ctx }) {
  const { view, when } = ctx;
  const mine = viewerOffice(view);
  const pendingFor = (office: GovernanceOffice) =>
    view.offers.find((offer) => offer.kind === 'COURT' && offer.office === office);
  return (
    <>
      {view.throne.emperorGeneralId === null ? (
        <p className={styles.note}>황제가 없어 세 직위가 모두 비어 있습니다. 즉위한 황제가 직위를 제안합니다.</p>
      ) : null}
      <div className={styles.cards}>
        {view.court.map(({ office, appointment, stipendGold }) => {
          const holds = appointment !== null && appointment.generalId === view.viewerGeneralId;
          const pending = pendingFor(office);
          return (
            <article key={office} className={holds ? `${styles.card} ${styles.mine}` : styles.card}>
              <h4>
                {OFFICE_LABEL[office]} {appointment ? null : <Tag tone="muted">공석</Tag>}
                {holds ? <Tag tone="info">내 직위</Tag> : null}
              </h4>
              <p>
                {appointment ? (
                  <>
                    <b>{generalName(view, appointment.generalId)}</b>{' '}
                    <span className={styles.note}>{when(appointment.appointedTick)} 임명</span>
                  </>
                ) : (
                  <span className={styles.note}>맡은 장수가 없습니다.</span>
                )}
              </p>
              <dl className={styles.preview}>
                <dt>대행 권한</dt>
                <dd>{OFFICE_POWER[office]}</dd>
                <dt>봉록</dt>
                <dd>매월 금 {formatCount(stipendGold)} · 천자 소재 거점 금에서 지급</dd>
              </dl>
              {pending && pending.kind === 'COURT' ? (
                <p className={styles.note}>
                  <Tag tone="accent">응답 대기</Tag> 임명 제안: {generalName(view, pending.targetGeneralId)} · 기한{' '}
                  {when(pending.expiresTick)}
                </p>
              ) : null}
              {view.roles.emperor && appointment ? (
                <div className={styles.row}>
                  <Action ctx={ctx} label="해임" payload={{ type: 'court.dismiss', office }} tone="danger" />
                </div>
              ) : holds ? (
                <div className={styles.row}>
                  <Action ctx={ctx} label="사임" payload={{ type: 'court.resign' }} tone="danger" />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {view.roles.emperor || view.roles.grandMarshal ? (
        <div className={styles.cards}>
          {view.roles.emperor ? <CourtOfferForm ctx={ctx} /> : null}
          <CensureForm ctx={ctx} />
        </div>
      ) : null}
      {mine ? <p className={styles.note}>지금 {OFFICE_LABEL[mine]} 직위를 맡고 있습니다.</p> : null}
      <details className={styles.disc}>
        <summary>직위별 권한</summary>
        <ul>
          <li>황제: 직위 제안·해임, 황실 명의 봉신 요구, 공납 면제, 견책을 직접 합니다.</li>
          {(['chancellor', 'grandMarshal', 'minister'] as const).map((office) => (
            <li key={office}>
              {OFFICE_LABEL[office]}: {OFFICE_POWER[office]}
            </li>
          ))}
          <li>
            직위는 황제 권한을 나눠 대행합니다. 다른 봉신 영주 아래 관계는 건드리지 않습니다. 승상·사도는 자국이
            하위국이거나 그 아래 계열인 관계를 해제·면제할 수 없습니다. 황제가 바뀌면 세 직위가 비워집니다.
          </li>
        </ul>
      </details>
    </>
  );
}

function CourtOfferForm({ ctx }: { ctx: Ctx }) {
  const { view } = ctx;
  const [draft, setDraft] = useState({ office: '', general: '' });
  // 직위마다 미결 제안은 한 건이다. 보낸 황제는 자기 제안을 조회에서 본다.
  const busyOffice = new Set<GovernanceOffice>(
    view.offers.flatMap((offer) => (offer.kind === 'COURT' ? [offer.office] : [])),
  );
  const vacant = view.court.filter((row) => row.appointment === null && !busyOffice.has(row.office));
  const office = vacant.find((row) => row.office === draft.office)?.office ?? null;
  const general = view.courtCandidates.find((id) => String(id) === draft.general) ?? null;
  const reason = office === null ? '직위를 고르세요.' : general === null ? '대상 장수를 고르세요.' : null;
  return (
    <article className={styles.card}>
      <h4>직위 임명 제안</h4>
      <div className={styles.form}>
        <label>
          직위
          <select value={draft.office} onChange={(e) => setDraft({ ...draft, office: e.target.value })}>
            <option value="">직위를 고르세요</option>
            {vacant.map((row) => (
              <option key={row.office} value={row.office}>
                {OFFICE_LABEL[row.office]}
              </option>
            ))}
          </select>
        </label>
        <label>
          대상 장수 (황제국 계열)
          <select value={draft.general} onChange={(e) => setDraft({ ...draft, general: e.target.value })}>
            <option value="">장수를 고르세요</option>
            {view.courtCandidates.map((id) => {
              const row = view.generals.find((item) => item.id === id);
              return (
                <option key={id} value={id}>
                  {generalName(view, id)}
                  {row?.nationId ? ` · ${nationName(view, row.nationId)}` : ''}
                </option>
              );
            })}
          </select>
        </label>
        {vacant.length ? null : (
          <p className={styles.note}>제안할 수 있는 빈 직위가 없습니다. 바꾸려면 먼저 해임하세요.</p>
        )}
        <p className={styles.note}>
          사람 장수는 본인이 수락해야 임명됩니다. NPC 장수는 월 정산에서 판정합니다. {view.limits.offerMonths}개월 안에
          응답이 없으면 제안이 지워집니다.
        </p>
        <div className={styles.row}>
          <Action
            ctx={ctx}
            label="임명 제안 보내기"
            reason={reason}
            payload={office && general ? { type: 'court.offer', office, generalId: general } : null}
          />
        </div>
      </div>
    </article>
  );
}

function CensureForm({ ctx }: { ctx: Ctx }) {
  const { view } = ctx;
  const [target, setTarget] = useState('');
  const options = censureTargets(view);
  const nation = options.find((row) => String(row.id) === target)?.id ?? null;
  return (
    <article className={styles.card}>
      <h4>견책</h4>
      <div className={styles.form}>
        <label>
          대상 국가 (황제국 계열 밖)
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">국가를 고르세요</option>
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · 정통성 {legitimacyOf(view, row.id) ?? '—'}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.note}>
          대상 정통성 −{view.limits.censureLoss}. 같은 국가는 {view.limits.censureCooldownMonths}개월에 한 번입니다.
        </p>
        <div className={styles.row}>
          <Action
            ctx={ctx}
            label="견책 요청 보내기"
            tone="danger"
            reason={nation === null ? '대상 국가를 고르세요.' : null}
            payload={nation === null ? null : { type: 'court.censure', nationId: nation }}
          />
        </div>
      </div>
    </article>
  );
}

// 내 계열·내 관계·제안 보내기를 먼저 두고, 전체 공개 계열도와 다른 관계는 접힌 칸(native details)에 둔다.
// 접힌 칸은 열고 닫아도 위 입력을 다시 만들지 않는다.
function RealmTab({ ctx }: { ctx: Ctx }) {
  const { view, when } = ctx;
  const tree = realm(view);
  const scope = realmScope(view);
  const node = (id: number): ReactNode => {
    const kids = tree.children.get(id) ?? [];
    const edge = view.vassals.find((row) => row.vassalNationId === id);
    return (
      <li key={id}>
        <span className={styles.node}>
          <Nation view={view} id={id} />
          {view.ownNationId === id ? <Tag tone="info">내 국가</Tag> : null}
          {view.throne.emperorNationId === id ? <Tag tone="accent">황제국</Tag> : null}
          {view.seat.nationId === id ? <Tag tone="info">거점</Tag> : null}
          <span className={styles.note}>
            정통성 {legitimacyOf(view, id) ?? '—'}
            {edge ? ` · ${when(edge.sinceTick)}부터 ${nationName(view, edge.overlordNationId)}의 봉신` : ' · 최상위'}
          </span>
        </span>
        {kids.length ? <ul>{kids.map(node)}</ul> : null}
      </li>
    );
  };
  return (
    <>
      <h4>내 계열</h4>
      {scope.root === null ? (
        <p className={styles.note}>소속 국가가 없어 내 계열이 없습니다. 아래 전체 계열도에서 공개 관계를 봅니다.</p>
      ) : (
        <ul className={styles.tree} aria-label="내 계열">
          {node(scope.root)}
        </ul>
      )}
      <p className={styles.note}>
        같은 계열 국가끼리는 선전포고·공격·공격 계략을 할 수 없습니다. 깊이는 최상위 0에서 최대 {view.limits.maxDepth}
        단계입니다.
      </p>
      <h4>내 관계 · {formatCount(scope.mine.length)}건</h4>
      {scope.mine.length ? (
        <div className={styles.cards}>
          {scope.mine.map((row) => (
            <RelationCard key={row.id} ctx={ctx} row={row} />
          ))}
        </div>
      ) : (
        <p className={styles.note}>자국이 당사국이거나 내가 다룰 수 있는 봉신 관계가 없습니다.</p>
      )}
      <OfferComposer ctx={ctx} />
      <details className={styles.disc}>
        <summary>
          전체 계열도 (공개) · {formatCount(view.nations.length)}개국 · 관계 {formatCount(view.vassals.length)}건
        </summary>
        <div className={styles.discBody}>
          <ul className={styles.tree} aria-label="전체 봉신 계열도">
            {scope.tops.map(node)}
          </ul>
          <h4>다른 관계 · {formatCount(scope.others.length)}건</h4>
          {scope.others.length ? (
            <div className={styles.cards}>
              {scope.others.map((row) => (
                <RelationCard key={row.id} ctx={ctx} row={row} />
              ))}
            </div>
          ) : (
            <p className={styles.note}>{view.vassals.length ? '나머지 관계가 없습니다.' : '봉신 관계가 없습니다.'}</p>
          )}
        </div>
      </details>
      <details className={styles.disc}>
        <summary>공개 범위</summary>
        <ul>
          <li>누구나: 황제, 거점, 직위 명단, 정통성, 관계의 존재(상위·하위·시작 연월)</li>
          <li>공납 비율·면제 기한: 두 나라 군주와 황제. 황제국이 직접 상위인 관계는 승상·사도도</li>
          <li>제안 내용: 보낸 쪽과 받는 쪽 당사자만</li>
          <li>공납 기록: 두 나라 군주만. 봉록 기록: 지급하는 거점 소유국 군주와, 받은 장수 본인의 입금만</li>
        </ul>
      </details>
    </>
  );
}

function RelationCard({ ctx, row }: { ctx: Ctx; row: GovernanceVassalRow }) {
  const { view, when, tick } = ctx;
  const [months, setMonths] = useState('');
  const can = vassalActions(view, row);
  const party =
    view.roles.monarch && (view.ownNationId === row.overlordNationId || view.ownNationId === row.vassalNationId);
  const remitting = row.remitUntilTick !== undefined && row.remitUntilTick > tick;
  const count = /^\d+$/.test(months.trim()) ? Number(months) : null;
  const remitReason =
    can.remit?.reason ??
    (count === null || count < 1 || count > view.limits.maxRemitMonths
      ? `면제 기간은 1~${view.limits.maxRemitMonths}개월의 정수로 넣으세요.`
      : null);
  return (
    <article className={party ? `${styles.card} ${styles.mine}` : styles.card}>
      <h4>
        <Nation view={view} id={row.overlordNationId} /> <span aria-hidden="true">→</span>
        <span className={styles.srOnly}>상위, 하위</span> <Nation view={view} id={row.vassalNationId} />
        {can.direct ? <Tag tone="accent">황제국 직접</Tag> : null}
        {party ? <Tag tone="info">당사국</Tag> : null}
      </h4>
      <p className={styles.note}>
        {row.id}번 계약 · {when(row.sinceTick)}부터
      </p>
      {row.goldBp !== undefined && row.riceBp !== undefined ? (
        <dl className={styles.preview}>
          <dt>공납 비율</dt>
          <dd>
            금 {percent(row.goldBp)} · 쌀 {percent(row.riceBp)}
          </dd>
          <dt>면제</dt>
          <dd>{remitting ? `${when(row.remitUntilTick!)}까지` : '없음'}</dd>
          {row.renouncePending ? (
            <>
              <dt>이탈</dt>
              <dd>다음 월 정산에 끝남</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className={styles.note}>
          <Tag tone="muted">비공개</Tag> 비율·면제 기한은 두 나라 군주와 황제
          {can.direct ? ', 승상·사도' : ''}만 봅니다.
        </p>
      )}
      {can.remit ? (
        <div className={styles.form}>
          <label>
            공납 면제 개월 (1~{view.limits.maxRemitMonths})
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={view.limits.maxRemitMonths}
              step={1}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </label>
          <div className={styles.row}>
            <Action
              ctx={ctx}
              label="면제 요청"
              tone="secondary"
              reason={remitReason}
              payload={remitReason ? null : { type: 'court.remit', vassalId: row.id, months: count! }}
            />
          </div>
        </div>
      ) : null}
      {can.release || can.renounce ? (
        <div className={styles.row}>
          {can.release ? (
            <Action
              ctx={ctx}
              label="관계 해제"
              tone="danger"
              reason={can.release.reason}
              payload={{ type: 'vassal.release', vassalId: row.id }}
            />
          ) : null}
          {can.renounce ? (
            <Action
              ctx={ctx}
              label="이탈"
              tone="danger"
              reason={can.renounce.reason}
              payload={{ type: 'vassal.renounce', vassalId: row.id }}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function OfferComposer({ ctx }: { ctx: Ctx }) {
  const { view } = ctx;
  const sources = offerSources(view);
  const name = useId();
  const [draft, setDraft] = useState<OfferDraft>({
    authority: sources.OWN.reason ? 'EMPIRE' : 'OWN',
    target: '',
    direction: 'DEMAND',
    gold: '',
    rice: '',
  });
  if (sources.OWN.reason && sources.EMPIRE.reason)
    return (
      <article className={styles.card}>
        <h4>봉신 제안 보내기</h4>
        <p className={styles.note}>봉신 제안은 자국 군주, 황제, 승상만 보낼 수 있습니다.</p>
      </article>
    );
  const check = offerCheck(view, draft);
  const authorities = [
    [
      'OWN',
      `자국 명의 · ${nationName(view, view.ownNationId)}`,
      '자국 군주로서 보냅니다. 군주에서 물러나면 제안이 무효가 됩니다.',
    ],
    [
      'EMPIRE',
      `황실 명의 · ${nationName(view, view.throne.emperorNationId)}`,
      `${view.roles.emperor ? '황제 본인' : '승상 대행'}. 요구만 가능하며 황위·승상직이 바뀌면 무효가 됩니다.`,
    ],
  ] as const;
  return (
    <article className={styles.card}>
      <h4>봉신 제안 보내기</h4>
      <form className={styles.form} onSubmit={(event) => event.preventDefault()} aria-label="봉신 제안">
        <fieldset className={styles.choice}>
          <legend>명의</legend>
          {authorities.map(([key, label, hint]) => (
            <label key={key}>
              <input
                type="radio"
                name={`${name}-authority`}
                value={key}
                checked={draft.authority === key}
                disabled={sources[key].reason !== null}
                onChange={() =>
                  setDraft({ ...draft, authority: key, direction: key === 'EMPIRE' ? 'DEMAND' : draft.direction })
                }
              />
              <span>
                {label}
                <small className={styles.note}>{sources[key].reason ?? hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          상대 국가
          <select value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}>
            <option value="">상대를 고르세요</option>
            {view.nations
              .filter((row) => row.id !== check.source)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · 정통성 {legitimacyOf(view, row.id) ?? '—'}
                </option>
              ))}
          </select>
        </label>
        <fieldset className={styles.choice}>
          <legend>관계 방향</legend>
          <label>
            <input
              type="radio"
              name={`${name}-direction`}
              value="DEMAND"
              checked={draft.direction === 'DEMAND'}
              onChange={() => setDraft({ ...draft, direction: 'DEMAND' })}
            />
            <span>
              요구<small className={styles.note}>상대가 우리 봉신이 됩니다.</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name={`${name}-direction`}
              value="REQUEST"
              checked={draft.direction === 'REQUEST'}
              disabled={draft.authority === 'EMPIRE'}
              onChange={() => setDraft({ ...draft, direction: 'REQUEST' })}
            />
            <span>
              청원
              <small className={styles.note}>
                {draft.authority === 'EMPIRE'
                  ? '황실 명의로는 청원을 보낼 수 없습니다.'
                  : '우리가 상대의 봉신이 됩니다.'}
              </small>
            </span>
          </label>
        </fieldset>
        <div className={styles.pair}>
          {(
            [
              ['gold', '금 공납 비율(%)'],
              ['rice', '쌀 공납 비율(%)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={view.limits.maxBp / 100}
                step={0.01}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div aria-live="polite" className={styles.form}>
          {check.upper !== null && check.lower !== null ? (
            <dl className={styles.preview} aria-label="제안 미리보기">
              <dt>수락되면</dt>
              <dd>
                상위 {nationName(view, check.upper)} · 하위 {nationName(view, check.lower)}
              </dd>
              <dt>공납 상한</dt>
              <dd>비율은 각각 최대 {percent(view.limits.maxBp)}이며 수락 뒤에는 바꿀 수 없습니다.</dd>
              <dt>기한</dt>
              <dd>{view.limits.offerMonths}개월 안에 응답이 없으면 지워집니다.</dd>
            </dl>
          ) : null}
          {check.reasons.length ? (
            <ul className={styles.reasons} aria-label="지금 보낼 수 없는 이유">
              {check.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <p className={styles.note}>
            전쟁 중인 계열끼리는 합칠 수 없고 미결 제안 수에도 한도가 있습니다. 처리할 때 서버가 다시 판정합니다.
          </p>
        </div>
        <div className={styles.row}>
          <Action ctx={ctx} label="제안 보내기" reason={check.reasons[0] ?? null} payload={check.payload} />
        </div>
      </form>
    </article>
  );
}

function OffersTab({ ctx }: { ctx: Ctx }) {
  const { received, sent } = splitOffers(ctx.view);
  return (
    <>
      <h4>받은 제안 · {formatCount(received.length)}건</h4>
      {received.length ? (
        <div className={styles.cards}>
          {received.map((offer) => (
            <OfferCard key={offer.id} ctx={ctx} offer={offer} received />
          ))}
        </div>
      ) : (
        <p className={styles.note}>응답할 제안이 없습니다.</p>
      )}
      <h4>보낸 제안 · {formatCount(sent.length)}건</h4>
      {sent.length ? (
        <div className={styles.cards}>
          {sent.map((offer) => (
            <OfferCard key={offer.id} ctx={ctx} offer={offer} received={false} />
          ))}
        </div>
      ) : (
        <p className={styles.note}>응답을 기다리는 보낸 제안이 없습니다.</p>
      )}
      <p className={styles.note}>
        제안 내용은 보낸 쪽과 받는 쪽만 봅니다. 사람이 받은 제안은 자동으로 수락되지 않습니다. 기한이 지나면 지워집니다.
      </p>
    </>
  );
}

function OfferCard({ ctx, offer, received }: { ctx: Ctx; offer: GovernanceOfferRow; received: boolean }) {
  const { view, when } = ctx;
  const role = <Tag tone={received ? 'info' : 'muted'}>{received ? '받은 제안' : '보낸 제안'}</Tag>;
  if (offer.kind === 'COURT') {
    const stipend = view.court.find((row) => row.office === offer.office)?.stipendGold;
    return (
      <article className={received ? `${styles.card} ${styles.mine}` : styles.card}>
        <h4>
          {OFFICE_LABEL[offer.office]} 임명 {role}
        </h4>
        <dl className={styles.preview}>
          <dt>보낸 이</dt>
          <dd>
            황제 {generalName(view, offer.actorId)} <Nation view={view} id={offer.fromNationId} />
          </dd>
          <dt>대상</dt>
          <dd>{generalName(view, offer.targetGeneralId)}</dd>
          <dt>대행 권한</dt>
          <dd>{OFFICE_POWER[offer.office]}</dd>
          {stipend !== undefined ? (
            <>
              <dt>봉록</dt>
              <dd>매월 금 {formatCount(stipend)}</dd>
            </>
          ) : null}
          <dt>기한</dt>
          <dd>{when(offer.expiresTick)}</dd>
        </dl>
        {received ? (
          <div className={styles.row}>
            <Action ctx={ctx} label="수락" payload={{ type: 'court.respond', offerId: offer.id, accept: true }} />
            <Action
              ctx={ctx}
              label="거절"
              tone="secondary"
              payload={{ type: 'court.respond', offerId: offer.id, accept: false }}
            />
          </div>
        ) : (
          <p className={styles.note}>상대 장수의 응답을 기다립니다.</p>
        )}
      </article>
    );
  }
  const [upper, lower] =
    offer.direction === 'DEMAND'
      ? [offer.fromNationId, offer.targetNationId]
      : [offer.targetNationId, offer.fromNationId];
  const by =
    offer.authority === 'EMPIRE'
      ? `${nationName(view, offer.fromNationId)} 황실 명의 · ${generalName(view, offer.actorId)}`
      : `${nationName(view, offer.fromNationId)} 명의 · 군주 ${generalName(view, offer.sourceMonarchId)}`;
  return (
    <article className={received ? `${styles.card} ${styles.mine}` : styles.card}>
      <h4>
        봉신 {offer.direction === 'DEMAND' ? '요구' : '청원'} {role}
        {offer.authority === 'EMPIRE' ? <Tag tone="accent">황실 명의</Tag> : null}
      </h4>
      <dl className={styles.preview}>
        <dt>보낸 이</dt>
        <dd>{by}</dd>
        <dt>수락되면</dt>
        <dd>
          상위 {nationName(view, upper)} · 하위 {nationName(view, lower)}
        </dd>
        <dt>공납</dt>
        <dd>
          금 {percent(offer.goldBp)} · 쌀 {percent(offer.riceBp)}
        </dd>
        <dt>기한</dt>
        <dd>{when(offer.expiresTick)}</dd>
      </dl>
      {received ? (
        <div className={styles.row}>
          <Action ctx={ctx} label="수락" payload={{ type: 'vassal.respond', offerId: offer.id, accept: true }} />
          <Action
            ctx={ctx}
            label="거절"
            tone="secondary"
            payload={{ type: 'vassal.respond', offerId: offer.id, accept: false }}
          />
        </div>
      ) : (
        <p className={styles.note}>상대 군주의 응답을 기다립니다. NPC 국가는 월 정산에서 판정합니다.</p>
      )}
    </article>
  );
}

function HistoryTab({ ctx }: { ctx: Ctx }) {
  const { view, when, cityName, movements: rows } = ctx;
  if (!rows.length)
    return (
      <p className={styles.note}>
        볼 수 있는 기록이 없습니다. 공납 기록은 당사국 군주만, 봉록 기록은 지급하는 거점 소유국 군주와 받은 장수 본인의
        입금만 보입니다.
      </p>
    );
  const columns: Column<GovernanceMovementRow>[] = [
    { key: 'tick', label: '연월', sortValue: (row) => row.tick, render: (row) => when(row.tick) },
    {
      key: 'kind',
      label: '구분',
      render: (row) => {
        if (row.kind === 'STIPEND') {
          const office = officeByRef(row.refId);
          return `봉록${office ? ` · ${OFFICE_LABEL[office]}` : ''}`;
        }
        return `공납 · ${nationName(view, row.fromNationId)}→${nationName(view, row.toNationId)}`;
      },
    },
    {
      key: 'holder',
      label: '보유처',
      render: (row) =>
        row.holder === 'city'
          ? cityName(row.holderId)
          : row.holderId === view.viewerGeneralId
            ? '내 장수'
            : generalName(view, row.holderId),
    },
    { key: 'resource', label: '자원', render: (row) => (row.resource === 'gold' ? '금' : '쌀') },
    {
      key: 'delta',
      label: '증감',
      numeric: true,
      sortValue: (row) => row.delta,
      render: (row) => `${row.delta > 0 ? '+' : ''}${formatCount(row.delta)}`,
    },
  ];
  return (
    <>
      <DataTable
        caption="황실 금액 기록 (최근)"
        rows={rows}
        columns={columns}
        rowKey={(row) => `${row.tick}:${row.sequence}:${row.ordinal}`}
        mobileDetails={['holder', 'resource']}
      />
      <p className={styles.note}>
        이체 한 건은 출금·입금 두 줄입니다. 공납은 정해진 달, 봉록은 매월 월 정산에서만 생깁니다. 잔액과 다른 사람
        지갑은 보이지 않습니다.
      </p>
    </>
  );
}

function confirmText(
  view: GovernanceView,
  payload: GovernanceInput,
  cityName: (key: number) => string,
): Omit<Confirm, 'payload' | 'userId' | 'session' | 'generalId'> {
  const seat = cityName(view.seat.cityKey);
  const vassal = (id: number) => view.vassals.find((row) => row.id === id);
  const pair = (upper: number, lower: number) => `상위 ${nationName(view, upper)} · 하위 ${nationName(view, lower)}`;
  const recheck = '처리할 때 조건을 다시 판정합니다. 그사이 바뀌면 거부됩니다.';
  switch (payload.type) {
    case 'throne.ascend':
      return {
        title: '즉위 요청',
        ok: '즉위 요청 보내기',
        danger: false,
        lines: [
          `처리되면 ${nationName(view, view.ownNationId)}이 황제국이 됩니다. 사람 군주는 자동으로 즉위하지 않습니다.`,
          '황제는 조정 세 직위를 제안·해임하고 공납 면제와 견책을 직접 할 수 있습니다.',
          `거점 ${seat}을 잃거나 군주가 아니게 되거나 황제국이 봉신이 되면 폐위되고 세 직위도 비워집니다.`,
          recheck,
        ],
      };
    case 'throne.abdicate':
      return {
        title: '퇴위 요청',
        ok: '퇴위 요청 보내기',
        danger: true,
        lines: [
          '황위에서 물러납니다. 다시 오르려면 조건을 채우고 즉위를 요청해야 합니다.',
          '세 직위와 응답 대기 중인 조정 제안, 황실 명의 제안이 함께 정리됩니다. 봉신 관계는 그대로입니다.',
        ],
      };
    case 'vassal.offer': {
      const source = offerSources(view)[payload.authority].nationId;
      const [upper, lower] =
        payload.direction === 'DEMAND' ? [source!, payload.targetNationId] : [payload.targetNationId, source!];
      return {
        title: '봉신 제안 보내기',
        ok: '제안 보내기',
        danger: false,
        lines: [
          payload.authority === 'OWN'
            ? `명의: ${nationName(view, source)} (자국 군주)`
            : `명의: ${nationName(view, source)} 황실 (${view.roles.emperor ? '황제 본인' : '승상 대행'})`,
          `수락되면: ${pair(upper, lower)}`,
          `공납: 금 ${percent(payload.goldBp)} · 쌀 ${percent(payload.riceBp)}. 수락 뒤에는 비율을 바꿀 수 없습니다.`,
          `${view.limits.offerMonths}개월 안에 응답이 없으면 지워집니다. 사람 군주는 직접 수락해야 하고 NPC 국가는 월 정산에서 판정합니다.`,
        ],
      };
    }
    case 'vassal.respond': {
      const offer = view.offers.find((row) => row.id === payload.offerId);
      if (!payload.accept || !offer || offer.kind !== 'VASSAL')
        return {
          title: '봉신 제안 거절',
          ok: '거절 요청 보내기',
          danger: false,
          lines: ['거절하면 이 제안은 지워집니다. 상대는 다시 제안할 수 있습니다.'],
        };
      const [upper, lower] =
        offer.direction === 'DEMAND'
          ? [offer.fromNationId, offer.targetNationId]
          : [offer.targetNationId, offer.fromNationId];
      return {
        title: '봉신 제안 수락',
        ok: '수락 요청 보내기',
        danger: false,
        lines: [
          `수락하면: ${pair(upper, lower)}`,
          `공납: 금 ${percent(offer.goldBp)} · 쌀 ${percent(offer.riceBp)}. 하위국 수도 창고에서 걷습니다.`,
          '수락 때 양쪽 군주가 기록됩니다. 어느 쪽 군주가 바뀌어도 관계가 해제됩니다.',
          '같은 계열 국가끼리는 선전포고·공격·공격 계략을 할 수 없습니다.',
          recheck,
        ],
      };
    }
    case 'vassal.release': {
      const row = vassal(payload.vassalId);
      return {
        title: '봉신 관계 해제',
        ok: '해제 요청 보내기',
        danger: true,
        lines: [
          row ? `해제: ${pair(row.overlordNationId, row.vassalNationId)}` : `${payload.vassalId}번 계약 해제`,
          '처리되면 바로 끝나며 다음 공납부터 걷지 않습니다. 다시 맺으려면 새 제안과 수락이 필요합니다.',
        ],
      };
    }
    case 'vassal.renounce': {
      const row = vassal(payload.vassalId);
      return {
        title: '봉신 이탈',
        ok: '이탈 요청 보내기',
        danger: true,
        lines: [
          row
            ? `${nationName(view, row.vassalNationId)}이 ${nationName(view, row.overlordNationId)}에서 벗어납니다.`
            : `${payload.vassalId}번 계약에서 벗어납니다.`,
          '다음 월 정산에 관계가 끝나며 그 전 정산의 공납은 걷힐 수 있습니다.',
          `관계가 끝날 때 ${row ? nationName(view, row.vassalNationId) : '이탈하는 국가'}의 정통성이 ${view.limits.renounceLoss} 내려갑니다.`,
        ],
      };
    }
    case 'court.offer':
      return {
        title: `${OFFICE_LABEL[payload.office]} 임명 제안`,
        ok: '제안 보내기',
        danger: false,
        lines: [
          `대상: ${generalName(view, payload.generalId)}`,
          `맡으면: ${OFFICE_POWER[payload.office]}`,
          `${view.limits.offerMonths}개월 안에 응답이 없으면 지워집니다.`,
        ],
      };
    case 'court.respond': {
      const offer = view.offers.find((row) => row.id === payload.offerId);
      const office = offer?.kind === 'COURT' ? offer.office : null;
      const stipend = office ? view.court.find((row) => row.office === office)?.stipendGold : undefined;
      if (!payload.accept || !office)
        return {
          title: '직위 제안 거절',
          ok: '거절 요청 보내기',
          danger: false,
          lines: ['거절하면 이 제안은 지워집니다.'],
        };
      return {
        title: `${OFFICE_LABEL[office]} 직위 수락`,
        ok: '수락 요청 보내기',
        danger: false,
        lines: [
          `맡으면: ${OFFICE_POWER[office]}`,
          ...(stipend !== undefined
            ? [
                `봉록: 매월 금 ${formatCount(stipend)}. 거점 ${seat} 금에서 내 장수에게 지급하며 거점 금이 모자라면 그달은 건너뜁니다.`,
              ]
            : []),
          '황제가 해임하거나 황제국 계열을 떠나면 직위가 비워집니다. 언제든 사임할 수 있습니다.',
        ],
      };
    }
    case 'court.dismiss': {
      const holder = view.court.find((row) => row.office === payload.office)?.appointment?.generalId ?? null;
      return {
        title: `${OFFICE_LABEL[payload.office]} 해임`,
        ok: '해임 요청 보내기',
        danger: true,
        lines: [`대상: ${generalName(view, holder)}`, '직위가 바로 비워지고 다음 달부터 봉록을 주지 않습니다.'],
      };
    }
    case 'court.resign':
      return {
        title: '직위 사임',
        ok: '사임 요청 보내기',
        danger: true,
        lines: ['직위가 바로 비워지고 다음 달부터 봉록을 받지 않습니다. 다시 맡으려면 황제의 새 제안이 필요합니다.'],
      };
    case 'court.remit': {
      const row = vassal(payload.vassalId);
      return {
        title: '공납 면제',
        ok: '면제 요청 보내기',
        danger: false,
        lines: [
          row ? `대상: ${pair(row.overlordNationId, row.vassalNationId)}` : `${payload.vassalId}번 계약`,
          `처리한 달부터 ${payload.months}개월 동안 공납을 걷지 않습니다. 이미 면제 중이면 이번 요청 기준으로 다시 정합니다.`,
          '면제한 공납은 나중에 몰아서 걷지 않습니다.',
        ],
      };
    }
    case 'court.censure':
      return {
        title: '견책',
        ok: '견책 요청 보내기',
        danger: true,
        lines: [
          `대상: ${nationName(view, payload.nationId)} (지금 정통성 ${legitimacyOf(view, payload.nationId) ?? '—'})`,
          `정통성이 ${view.limits.censureLoss} 내려가고 같은 국가는 ${view.limits.censureCooldownMonths}개월 동안 다시 견책할 수 없습니다.`,
          recheck,
        ],
      };
  }
}

// 확인 대화상자. 초점을 안에 가두고 Escape로 닫으며, 닫으면 연 단추로 초점을 돌린다(호출 쪽).
function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: (send: boolean) => void }) {
  const titleId = useId(),
    bodyId = useId();
  const ok = useRef<HTMLButtonElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (confirm.danger ? cancel : ok).current?.focus();
  }, [confirm.danger]);
  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={confirm.danger ? `${styles.dialog} ${styles.dangerDialog}` : styles.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose(false);
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === ok.current ? cancel : ok).current?.focus();
          }
        }}
      >
        <h2 id={titleId} className={styles.dialogTitle}>
          {confirm.title}
        </h2>
        <div id={bodyId} className={styles.dialogBody}>
          {confirm.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className={styles.row}>
          <button
            ref={ok}
            type="button"
            className={confirm.danger ? styles.danger : styles.primary}
            onClick={() => onClose(true)}
          >
            {confirm.ok}
          </button>
          <button ref={cancel} type="button" className={styles.secondary} onClick={() => onClose(false)}>
            그만두기
          </button>
        </div>
      </div>
    </div>
  );
}
