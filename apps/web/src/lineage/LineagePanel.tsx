import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { formatYearMonth, personalLogDate } from '../game/gameDate';
import { officerName } from '../game/names';
import { useWorldSummary } from '../game/queries';
import base from '../governance/governance.module.css';
import { DataTable, type Column } from '../ui/DataTable';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import styles from './lineage.module.css';
import {
  comingOfAgeYear,
  describeAction,
  failureLabel,
  families,
  familyRoot,
  formatCount,
  marriagesOf,
  nationOf,
  nextAction,
  offerHouseholdCity,
  personAge,
  personCity,
  personName,
  personOf,
  personOffice,
  previewRows,
  proposalRule,
  SEX_LABEL,
  spouseOf,
  type Family,
  type LineageBoard,
  type LineageInput,
  type LineageMine,
  type LineageOffer,
  type LineageSex,
  type LineageTab,
  type LineageView,
  type SuccessionPreview,
} from './lineageModel';
import { ownerCurrent, type LineageOwner } from './lineageRequestState';
import { useLineageBoard } from './useLineageBoard';

// 장수 정보 칸 아래의 가문 칸 (T4-95, AC-P2-32). 가계·혼인·제안·계승·기록을 lineage.get 값으로만 보인다.
// 모든 행동은 확인 대화상자를 거쳐 명시 요청 한 건으로 보낸다. 명령 카드·예턴에는 넣지 않는다.
// world.summary에 lineageEnabled가 있을 때만 조회한다. 없으면 아무것도 그리지 않고 요청도 하지 않는다.
export function LineagePanel({ worldId }: { worldId: string }) {
  const data = useWorldSummary(worldId).data;
  const enabled = data !== undefined && 'lineageEnabled' in data && data.lineageEnabled === true;
  return enabled ? <LineageBoardView key={worldId} worldId={worldId} /> : null;
}

type When = (tick: number) => string;
type Ask = (payload: LineageInput, event: MouseEvent<HTMLElement>) => void;
type Ctx = {
  view: LineageView;
  mine: LineageMine | null;
  when: When;
  lock: string | null;
  busy: boolean;
  ask: Ask;
  goto: (tab: LineageTab, target: string) => void;
  anchor: (target: string) => string;
};
type Confirm = LineageOwner & {
  payload: LineageInput;
  title: string;
  ok: string;
  danger: boolean;
  lines: ReactNode[];
  // 있으면 이 문장에 체크해야 보낼 수 있다(되돌릴 수 없는 계승·청구).
  ack: string | null;
};

const TABS = [
  ['family', '가문'],
  ['marriage', '혼인'],
  ['offers', '제안'],
  ['succession', '계승'],
  ['history', '기록'],
] as const satisfies ReadonlyArray<readonly [LineageTab, string]>;

function readOnlyReason(board: LineageBoard): string {
  if (board.status !== 'RUNNING') return '진행 중인 월드가 아니라 가문 정보는 볼 수만 있습니다.';
  if (board.settling)
    return '월 정산을 처리하는 중이라 지금은 볼 수만 있습니다. 정산이 끝나면 다시 요청할 수 있습니다.';
  if (!board.view.mine) return '장수가 있어야 가문 요청을 보낼 수 있습니다.';
  if (!board.view.mine.active) return '등장한 장수만 가문 요청을 보낼 수 있습니다.';
  return '이 월드의 이용이 제한된 동안에는 볼 수만 있습니다.';
}

function LineageBoardView({ worldId }: { worldId: string }) {
  const board = useLineageBoard(worldId);
  const summary = useWorldSummary(worldId);
  const titleId = useId(),
    anchorId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [tab, setTab] = useState<LineageTab>('family');
  const opener = useRef<HTMLElement | null>(null);
  const { view: state, notice } = board;
  const owner = state && { userId: state.userId, session: board.session, actorId: state.board.view.actorId };
  const live = confirm && ownerCurrent(confirm, owner) ? confirm : null;
  useEffect(() => {
    if (!confirm || live) return;
    // 계정·세션·장수가 바뀌어 무효가 된 대화상자는 버린다. 초점은 제목으로 옮긴다.
    setConfirm(null);
    opener.current = null;
    heading.current?.focus();
  }, [confirm, live]);
  if (board.off) return null;
  const view = state?.board.view ?? null;
  // 대기 요청을 보낸 장수가 지금 장수와 다르다(계승 뒤). 미확인이면 다시 접수 대신 확인 뒤 기록 지우기만 연다.
  const oldActor = !!state?.pending && !!view && view.actorId !== null && state.pending.generalId !== view.actorId;
  const clock = summary.data;
  const when: When = (tick) => (clock ? formatYearMonth(personalLogDate(tick, clock)) : '—');
  const lock = !state
    ? '가문 정보를 확인하는 중입니다.'
    : state.pending
      ? '앞 가문 요청의 결과를 기다리는 중입니다. 상태를 확인한 뒤 보내세요.'
      : board.stale
        ? '보이는 값이 오래됐을 수 있습니다. 새로 확인한 뒤 보내세요.'
        : !board.canSubmit
          ? readOnlyReason(state.board)
          : null;
  const anchor = (target: string) => `${anchorId}-${target}`;
  const ask: Ask = (payload, event) => {
    if (!state || !view || view.actorId === null || lock || board.busy) return;
    opener.current = event.currentTarget;
    setConfirm({
      payload,
      ...confirmText(view, payload, when),
      userId: state.userId,
      session: board.session,
      actorId: view.actorId,
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
  const goto = (next: LineageTab, target: string) => {
    setTab(next);
    requestAnimationFrame(() => document.getElementById(anchor(target))?.focus());
  };

  return (
    <section className={base.panel} aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1} className={base.title}>
        가문
      </h3>
      {notice ? (
        <p className={notice.tone === 'error' ? base.error : notice.tone === 'ok' ? base.ok : base.info} role="status">
          {notice.text}
        </p>
      ) : null}
      {!state || !view ? (
        board.busy ? (
          <LoadingState>가문 정보를 확인하는 중</LoadingState>
        ) : (
          <div className={base.row}>
            {board.retryWait ? <p role="status">{board.retryWait}초 뒤에 다시 확인하세요.</p> : null}
            <button
              type="button"
              className={base.secondary}
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
            <div className={base.row}>
              <p className={base.note}>
                보이는 값이 오래됐을 수 있습니다. 새로 확인하기 전에는 새 요청을 보내지 않습니다.
              </p>
              <button type="button" className={base.secondary} disabled={board.busy} onClick={() => void board.load()}>
                새로 확인
              </button>
            </div>
          ) : null}
          {state.pending ? (
            <div className={base.status} role="status" aria-live="polite">
              <p>
                <strong>요청 처리 대기</strong> · {describeAction(view, state.pending.payload)}
              </p>
              <p className={base.note}>
                {!board.unconfirmed
                  ? '접수한 요청을 처리하고 있습니다. 결과가 나올 때까지 다른 가문 요청은 기다려 주세요.'
                  : oldActor
                    ? '이 요청의 접수 기록을 찾지 못했습니다. 장수가 이미 바뀌어, 이전 장수 명의 요청은 서버가 거부하므로 앞으로도 처리되지 않습니다. 기록 지우기를 누르면 지금 장수와 접수 기록을 한 번 더 확인한 뒤 이 탭의 기록만 지웁니다. 다시 보내지 않습니다.'
                    : '이 요청의 접수 기록을 아직 찾지 못했습니다. 보내던 요청이 늦게 접수될 수도 있습니다. 같은 요청을 그대로 다시 접수하면 서버가 같은 번호로 한 번만 받습니다. 결과를 받기 전에는 새 요청을 만들지 않습니다.'}
              </p>
              {oldActor ? (
                <p className={base.note}>
                  이 요청은 이전 장수({personName(view, state.pending.generalId)}) 명의로 보냈습니다. 같은 번호로 결과만
                  확인합니다.
                </p>
              ) : null}
              {board.unconfirmed && !oldActor && !board.canSubmit ? (
                <p className={base.note}>지금은 다시 접수할 수 없어 같은 요청의 상태만 확인할 수 있습니다.</p>
              ) : null}
              <div className={base.row}>
                <button type="button" className={base.secondary} disabled={board.busy} onClick={board.recheck}>
                  같은 요청 상태 확인
                </button>
                {board.unconfirmed && !oldActor && board.canSubmit ? (
                  <button type="button" className={base.secondary} disabled={board.busy} onClick={board.resubmit}>
                    같은 요청 다시 접수
                  </button>
                ) : null}
                {board.unconfirmed && oldActor ? (
                  <button type="button" className={base.secondary} disabled={board.busy} onClick={board.forgetOld}>
                    이전 장수 요청 기록 지우기
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {!board.canSubmit ? (
            <p className={base.note} role="note">
              {readOnlyReason(state.board)}
            </p>
          ) : null}
          <Body
            key={`${state.userId}:${view.actorId}:${board.formEpoch}`}
            ctx={{ view, mine: view.mine, when, lock, busy: board.busy, ask, goto, anchor }}
            tab={tab}
            setTab={setTab}
          />
        </>
      )}
      {live ? <ConfirmDialog confirm={live} onClose={close} /> : null}
    </section>
  );
}

function Body({ ctx, tab, setTab }: { ctx: Ctx; tab: LineageTab; setTab: (tab: LineageTab) => void }) {
  const id = useId();
  const received = ctx.mine?.offers.filter((row) => row.toId === ctx.mine!.generalId).length ?? 0;
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
    <div className={base.body}>
      <Hud ctx={ctx} />
      <div className={styles.tabs} role="tablist" aria-label="가문 보기">
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
                <span className={base.count}>{formatCount(received)}</span>
                <span className={base.srOnly}>건 응답 대기</span>
              </>
            ) : null}
            {key === 'succession' && ctx.mine?.claim ? (
              <>
                {' '}
                <span className={base.count} aria-hidden="true">
                  !
                </span>
                <span className={base.srOnly}>군주 청구 가능</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className={base.tabPanel}>
        {tab === 'family' ? (
          <FamilyTab ctx={ctx} />
        ) : tab === 'marriage' ? (
          <MarriageTab ctx={ctx} />
        ) : tab === 'offers' ? (
          <OffersTab ctx={ctx} />
        ) : tab === 'succession' ? (
          <SuccessionTab ctx={ctx} />
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
  payload: LineageInput | null;
  reason?: string | null;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  const why = ctx.lock ?? reason;
  if (why || !payload) return <DisabledReason reason={why ?? '입력을 확인하세요.'}>{label}</DisabledReason>;
  return (
    <button type="button" className={base[tone]} disabled={ctx.busy} onClick={(event) => ctx.ask(payload, event)}>
      {label}
    </button>
  );
}

function SexTag({ sex }: { sex: LineageSex }) {
  return (
    <Tag tone={sex === 'UNKNOWN' ? 'muted' : 'info'}>
      <span className={base.srOnly}>성별 </span>
      {SEX_LABEL[sex]}
    </Tag>
  );
}

function Person({ ctx, id }: { ctx: Ctx; id: number }) {
  const { view, when } = ctx;
  const person = personOf(view, id);
  if (!person) return <b>장수 {id}</b>;
  const nation = nationOf(view, person.nationId);
  const debut = comingOfAgeYear(person);
  // 나이는 내 국가 장수에게만 온다. 없으면 칸을 비운다(공개 범위 안내는 가문 탭 아래에 있다).
  const age = personAge(person);
  return (
    <span className={styles.person}>
      <b>{person.name}</b>
      <SexTag sex={person.sex} />
      {person.exit ? (
        <Tag tone="muted">
          {person.exit.cause === 'DIED' ? '사망' : '은퇴'} {when(person.exit.tick)}
        </Tag>
      ) : (
        <>
          {age === null ? null : <span className={base.note}>{age}세</span>}
          {nation ? <NationBadge name={nation.name} color={nation.color} /> : <Tag tone="muted">재야</Tag>}
          {person.active ? null : <Tag tone="muted">미등장{debut === null ? '' : ` · ${debut}년 등장`}</Tag>}
        </>
      )}
      {id === view.actorId ? <Tag tone="info">나</Tag> : null}
      {view.mine && view.mine.heirId === id ? <Tag tone="accent">내 후계자</Tag> : null}
      {person.successorId !== null ? (
        <span className={base.note}>→ {personName(view, person.successorId)}이(가) 이음</span>
      ) : null}
    </span>
  );
}

function Household({ ctx, id }: { ctx: Ctx; id: number }) {
  return (
    <p className={styles.household}>
      <strong>가주 문구</strong> · 자녀는 출생 때 가주(제안한 장수 {personName(ctx.view, id)})의 국가·도시를 따르고
      가주의 성씨를 잇습니다. 가주는 성별과 관계없이 제안한 쪽입니다.
    </p>
  );
}

function Hud({ ctx }: { ctx: Ctx }) {
  const { view, mine, goto } = ctx;
  if (!mine) return <p className={base.note}>장수가 있어야 내 가문을 봅니다. 아래 공개 가계는 볼 수 있습니다.</p>;
  const me = personOf(view, mine.generalId);
  const where = me ? [personOffice(me), personCity(view, me)].filter((part) => part !== null) : [];
  const spouses = marriagesOf(view, mine.generalId);
  const next = nextAction(view);
  return (
    <dl className={base.hud} aria-label="내 가문 요약">
      <div>
        <dt>나</dt>
        <dd>
          <Person ctx={ctx} id={mine.generalId} />
        </dd>
        {where.length ? <dd className={base.note}>{where.join(' · ')}</dd> : null}
      </div>
      <div>
        <dt>배우자</dt>
        {spouses.length ? (
          spouses.map((row) => (
            <dd key={row.id}>
              <Person ctx={ctx} id={spouseOf(row, mine.generalId)} />{' '}
              <span className={base.note}>가주 {personName(view, row.householdGeneralId)}</span>
            </dd>
          ))
        ) : (
          <dd className={base.note}>없음</dd>
        )}
      </div>
      <div>
        <dt>후계자</dt>
        <dd>
          {mine.heirId === null ? <span className={base.note}>미지정</span> : <Person ctx={ctx} id={mine.heirId} />}
        </dd>
      </div>
      <div>
        <dt>다음 할 일</dt>
        <dd>{next.text}</dd>
        {next.tab !== null ? (
          <dd>
            <button type="button" className={base.primary} onClick={() => goto(next.tab, next.target)}>
              {next.label}
            </button>
          </dd>
        ) : null}
      </div>
    </dl>
  );
}

const familyKey = (row: Family) => `${row.household}:${row.other}`;

function FamilyNode({ ctx, family, all, seen }: { ctx: Ctx; family: Family; all: Family[]; seen: Set<string> }) {
  const inside = new Set(seen).add(familyKey(family));
  const below = (child: number) =>
    all.filter((row) => (row.household === child || row.other === child) && !inside.has(familyKey(row)));
  return (
    <li>
      <div className={styles.node}>
        <Tag tone="accent">가주</Tag> <Person ctx={ctx} id={family.household} />
        <span aria-hidden="true">─</span>
        <span className={base.srOnly}>배우자</span> <Person ctx={ctx} id={family.other} />
        {family.marriage ? (
          <span className={base.note}>{ctx.when(family.marriage.sinceTick)} 혼인</span>
        ) : (
          <Tag tone="muted">혼인 끝남</Tag>
        )}
      </div>
      {family.children.length ? (
        <ul>
          {family.children.map((child) => {
            const next = below(child);
            return (
              <li key={child}>
                <div className={styles.node}>
                  <span aria-hidden="true">└</span>
                  <span className={base.srOnly}>자녀</span>
                  <Person ctx={ctx} id={child} />
                </div>
                {next.length ? (
                  <ul>
                    {next.map((row) => (
                      <FamilyNode key={familyKey(row)} ctx={ctx} family={row} all={all} seen={inside} />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function FamilyTab({ ctx }: { ctx: Ctx }) {
  const { view, mine } = ctx;
  // 전체 가계는 접힌 칸을 열 때만 그린다. 공개 인물 전원을 매번 그리지 않는다.
  const [showAll, setShowAll] = useState(false);
  const all = families(view);
  const root = mine ? familyRoot(view, mine.generalId) : null;
  const own = root === null ? [] : all.filter((row) => row.household === root || row.other === root);
  const orphan = (id: number) => (personOf(view, id)?.parents.length ?? 0) === 0;
  const tops = all.filter((row) => orphan(row.household) && orphan(row.other));
  return (
    <>
      <h4 id={ctx.anchor('family')} tabIndex={-1} className={styles.anchor}>
        내 가문
      </h4>
      {own.length ? (
        <ul className={styles.fam} aria-label="내 가문">
          {own.map((row) => (
            <FamilyNode key={familyKey(row)} ctx={ctx} family={row} all={all} seen={new Set()} />
          ))}
        </ul>
      ) : (
        <>
          <p className={base.note}>아직 혼인·자녀가 없습니다. 자녀는 혼인한 남녀 부부에게서만 태어납니다.</p>
          {mine ? (
            <div className={base.row}>
              <button type="button" className={base.secondary} onClick={() => ctx.goto('marriage', 'marriage')}>
                혼인 후보 보기
              </button>
            </div>
          ) : null}
        </>
      )}
      <p className={base.note}>
        자녀는 출생 때 가주(혼인을 제안한 쪽)의 국가·도시·성씨를 따릅니다. 미등장 자녀는 등장한 뒤부터 후계자가 될 수
        있습니다.
      </p>
      <details className={base.disc} onToggle={(event) => setShowAll(event.currentTarget.open)}>
        <summary>전체 가계 (공개) · 가문 {formatCount(tops.length)}개</summary>
        {showAll ? (
          <div className={base.discBody}>
            {tops.length ? (
              <ul className={styles.fam} aria-label="전체 가계">
                {tops.map((row) => (
                  <FamilyNode key={familyKey(row)} ctx={ctx} family={row} all={all} seen={new Set()} />
                ))}
              </ul>
            ) : (
              <p className={base.note}>아직 공개된 혼인·출생이 없습니다.</p>
            )}
            <p className={base.note}>
              누구나 보는 것: 부모·배우자·자녀 관계, 가주, 출생, 성별, 퇴장 시점과 원인, 누가 누구를 이었는지. 후계
              지정·금액은 보이지 않습니다. 나이·도시·직책·사람 장수 여부·등장 연도는 내 장수와 같은 국가 장수만
              보입니다.
            </p>
          </div>
        ) : null}
      </details>
      <details className={base.disc}>
        <summary>성별 표시 안내</summary>
        <ul>
          <li>
            <SexTag sex="MALE" /> <SexTag sex="FEMALE" /> 출처로 확인했거나, 생성 때 플레이어가 골랐거나, 출생 때 정해진
            값입니다. 바뀌지 않습니다.
          </li>
          <li>
            <SexTag sex="UNKNOWN" /> 출처가 성별을 밝히지 않은 시나리오 인물입니다. 이름·초상·직책으로 추정하지 않으며
            혼인할 수 없습니다.
          </li>
          <li>나이·사망·계승·후계자·군주 청구는 성별을 보지 않습니다.</li>
        </ul>
      </details>
    </>
  );
}

function MarriageTab({ ctx }: { ctx: Ctx }) {
  const { view, mine, when } = ctx;
  if (!mine) return <p className={base.note}>장수가 있어야 혼인할 수 있습니다.</p>;
  const current = marriagesOf(view, mine.generalId);
  const ok = mine.marriageCandidates.filter((row) => row.failure === null);
  const no = mine.marriageCandidates.flatMap((row) =>
    row.failure ? [{ id: row.generalId, failure: row.failure }] : [],
  );
  const tally = new Map<string, number>();
  for (const row of no) tally.set(failureLabel(row.failure), (tally.get(failureLabel(row.failure)) ?? 0) + 1);
  return (
    <>
      {current.length ? (
        <article className={`${base.card} ${base.mine}`}>
          <h4>지금 혼인</h4>
          {current.map((row) => (
            <p key={row.id}>
              <Person ctx={ctx} id={spouseOf(row, mine.generalId)} />{' '}
              <span className={base.note}>
                {when(row.sinceTick)}부터 · 가주 {personName(view, row.householdGeneralId)}
                {row.householdGeneralId === mine.generalId ? '(나)' : ''}
              </span>
            </p>
          ))}
        </article>
      ) : null}
      {personOf(view, mine.generalId)?.sex === 'UNKNOWN' ? (
        <p className={base.note}>내 성별이 미상이라 혼인할 수 없습니다.</p>
      ) : null}
      <h4 id={ctx.anchor('marriage')} tabIndex={-1} className={styles.anchor}>
        지금 혼인할 수 있는 장수 <span className={base.note}>{formatCount(ok.length)}명</span>
      </h4>
      <p className={styles.household}>
        <strong>가주</strong> · 제안을 보낸 장수가 가주가 됩니다. 성별과 관계없습니다. 자녀는 출생 때 가주의 국가·도시를
        따르고 가주의 성씨를 잇습니다. 가주가 되려면 먼저 제안하세요.
      </p>
      {ok.length ? (
        <div className={base.cards}>
          {ok.map((row) => (
            <article key={row.generalId} className={base.card}>
              <h4>
                <Person ctx={ctx} id={row.generalId} />
              </h4>
              <p className={base.note}>{proposalRule(view, row.generalId)}</p>
              <div className={base.row}>
                <Action
                  ctx={ctx}
                  label="혼인 제안"
                  payload={{ type: 'marriage.propose', targetGeneralId: row.generalId }}
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className={base.note}>지금 바로 혼인할 수 있는 장수가 없습니다.</p>
      )}
      {no.length ? (
        <>
          <h4>
            지금은 안 되는 장수 <span className={base.note}>{formatCount(no.length)}명</span>
          </h4>
          <ul className={styles.tally} aria-label="사유별 수">
            {[...tally].map(([label, count]) => (
              <li key={label}>
                <Tag tone="muted">
                  {label} {formatCount(count)}
                </Tag>
              </li>
            ))}
          </ul>
          <details className={base.disc}>
            <summary>사유와 함께 보기 · {formatCount(no.length)}명</summary>
            <ul className={styles.rows} aria-label="지금은 안 되는 장수">
              {no.map((row) => (
                <li key={row.id}>
                  <span className={styles.node}>
                    <Person ctx={ctx} id={row.id} />
                    <Tag tone="muted">{failureLabel(row.failure)}</Tag>
                  </span>
                  <span className={base.note}>{row.failure.message}</span>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      <p className={base.note}>
        혼인은 남·여 짝만 됩니다. 판정은 서버가 하며 화면은 성별로 거르지 않습니다. 처리할 때 다시 판정합니다.
      </p>
    </>
  );
}

function OfferCard({ ctx, offer, received }: { ctx: Ctx; offer: LineageOffer; received: boolean }) {
  const { view, when } = ctx;
  // 가주 도시는 제안 당사자에게만 오는 offers 값이다. 공개 인물 칸(people)의 위치는 쓰지 않는다.
  const city = offerHouseholdCity(view, offer);
  return (
    <article className={received ? `${base.card} ${base.mine}` : base.card}>
      <h4>
        혼인 제안 <Tag tone={received ? 'info' : 'muted'}>{received ? '받은 제안' : '보낸 제안'}</Tag>
      </h4>
      <dl className={base.preview}>
        <dt>{received ? '보낸 장수' : '받는 장수'}</dt>
        <dd>
          <Person ctx={ctx} id={received ? offer.fromId : offer.toId} />
        </dd>
        <dt>가주</dt>
        <dd>
          {personName(view, offer.householdGeneralId)}
          {offer.householdGeneralId === view.actorId ? ' (나)' : ''} · 제안한 쪽
        </dd>
        {city === null ? null : (
          <>
            <dt>가주 도시</dt>
            <dd>{city} (지금 기준, 출생 때 다시 정함)</dd>
          </>
        )}
        <dt>기한</dt>
        <dd>{when(offer.expiresTick)}</dd>
      </dl>
      <Household ctx={ctx} id={offer.householdGeneralId} />
      {received ? (
        <div className={base.row}>
          <Action ctx={ctx} label="수락" payload={{ type: 'marriage.respond', offerId: offer.id, accept: true }} />
          <Action
            ctx={ctx}
            label="거절"
            tone="secondary"
            payload={{ type: 'marriage.respond', offerId: offer.id, accept: false }}
          />
        </div>
      ) : (
        <p className={base.note}>상대가 직접 수락해야 성립합니다. 기한이 지나면 지워집니다.</p>
      )}
    </article>
  );
}

function OffersTab({ ctx }: { ctx: Ctx }) {
  const mine = ctx.mine;
  if (!mine) return <p className={base.note}>장수가 있어야 혼인 제안을 봅니다.</p>;
  const received = mine.offers.filter((row) => row.toId === mine.generalId);
  const sent = mine.offers.filter((row) => row.fromId === mine.generalId);
  return (
    <>
      <h4 id={ctx.anchor('offers')} tabIndex={-1} className={styles.anchor}>
        받은 제안 · {formatCount(received.length)}건
      </h4>
      {received.length ? (
        <div className={base.cards}>
          {received.map((row) => (
            <OfferCard key={row.id} ctx={ctx} offer={row} received />
          ))}
        </div>
      ) : (
        <p className={base.note}>응답할 혼인 제안이 없습니다.</p>
      )}
      <h4>보낸 제안 · {formatCount(sent.length)}건</h4>
      {sent.length ? (
        <div className={base.cards}>
          {sent.map((row) => (
            <OfferCard key={row.id} ctx={ctx} offer={row} received={false} />
          ))}
        </div>
      ) : (
        <p className={base.note}>응답을 기다리는 보낸 제안이 없습니다.</p>
      )}
      <p className={base.note}>
        제안 내용은 두 당사자만 봅니다. 사람이 받은 제안은 자동으로 수락되지 않습니다. 상대가 먼저 보낸 제안이 있으면
        반대 방향 제안은 만들 수 없고 그 제안에 응답해야 합니다.
      </p>
    </>
  );
}

function PreviewList({ view, preview }: { view: LineageView; preview: SuccessionPreview }) {
  return (
    <dl className={base.preview} aria-label="계승 미리보기">
      {previewRows(view, preview).map(([label, lines]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>
            {lines.length === 1 ? (
              lines[0]
            ) : (
              <ul className={styles.lines}>
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function SuccessionTab({ ctx }: { ctx: Ctx }) {
  const { view, mine } = ctx;
  if (!mine) return <p className={base.note}>장수가 있어야 후계를 정할 수 있습니다.</p>;
  const claimNation = mine.claim ? nationOf(view, mine.claim.nationId) : undefined;
  const heir = mine.heirId;
  return (
    <>
      {mine.claim ? (
        <article className={`${base.card} ${base.mine}`}>
          <h4 id={ctx.anchor('claim')} tabIndex={-1} className={styles.anchor}>
            {claimNation ? <NationBadge name={claimNation.name} color={claimNation.color} /> : null} 군주 공석
          </h4>
          <p>
            군주 자리가 비었습니다. 사람 장수는 자동으로 즉위하지 않습니다. 원하면 직접 청구하세요. 지금 직책은{' '}
            {officerName(mine.claim.currentOfficerLevel)}입니다.
          </p>
          <div className={base.row}>
            <Action
              ctx={ctx}
              label="군주 자리 청구"
              tone="danger"
              payload={{ type: 'ruler.claim', nationId: mine.claim.nationId }}
            />
          </div>
        </article>
      ) : null}
      <div className={base.cards}>
        <article className={heir === null ? base.card : `${base.card} ${base.mine}`}>
          <h4 id={ctx.anchor('heir')} tabIndex={-1} className={styles.anchor}>
            후계자 {heir === null ? <Tag tone="muted">미지정</Tag> : <Tag tone="accent">지정됨</Tag>}
          </h4>
          <p className={base.note}>
            같은 국가의 살아 있는 NPC 직계 자손만 됩니다. 성별은 보지 않습니다. 지정은 나만 봅니다.
          </p>
          {mine.heirCandidates.length ? (
            <ul className={styles.rows} aria-label="후계 후보">
              {mine.heirCandidates.map((row) => (
                <li key={row.generalId}>
                  <span className={styles.node}>
                    <Person ctx={ctx} id={row.generalId} />
                  </span>
                  {row.failure ? (
                    <span className={base.note}>{row.failure.message}</span>
                  ) : (
                    <span className={base.row}>
                      {heir === row.generalId ? (
                        <Action
                          ctx={ctx}
                          label="지정 해제"
                          tone="secondary"
                          payload={{ type: 'heir.designate', heirGeneralId: null }}
                        />
                      ) : (
                        <Action
                          ctx={ctx}
                          label="후계자로 지정"
                          tone="secondary"
                          payload={{ type: 'heir.designate', heirGeneralId: row.generalId }}
                        />
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className={base.note}>
              직계 자손이 없습니다. 혼인·출생 뒤 지정할 수 있습니다. 비혈연 후계자는 없습니다.
            </p>
          )}
          {heir !== null && !mine.heirCandidates.some((row) => row.generalId === heir) ? (
            <div className={base.row}>
              <Action
                ctx={ctx}
                label="지정 해제"
                tone="secondary"
                payload={{ type: 'heir.designate', heirGeneralId: null }}
              />
            </div>
          ) : null}
        </article>
        {heir !== null ? (
          <article className={`${base.card} ${base.mine}`}>
            <h4 id={ctx.anchor('preview')} tabIndex={-1} className={styles.anchor}>
              계승 미리보기 · {personName(view, mine.generalId)} → {personName(view, heir)}
            </h4>
            <p className={base.note}>나만 봅니다. 확정하면 이 내용 그대로만 계승되고 처리 때 다르면 거부됩니다.</p>
            {mine.previewFailure ? (
              <ul className={base.reasons} aria-label="지금 계승할 수 없는 이유">
                <li>
                  {mine.previewFailure.message} ({mine.previewFailure.code})
                </li>
              </ul>
            ) : null}
            {mine.preview ? <PreviewList view={view} preview={mine.preview} /> : null}
            <div className={base.row}>
              <Action
                ctx={ctx}
                label="계승 확정…"
                tone="danger"
                reason={mine.preview ? null : (mine.previewFailure?.message ?? '계승 미리보기를 만들 수 없습니다.')}
                payload={
                  mine.preview ? { type: 'succession.confirm', heirGeneralId: heir, expected: mine.preview } : null
                }
              />
            </div>
          </article>
        ) : null}
      </div>
      <p className={base.note}>
        사람 장수는 수명으로 죽거나 바뀌지 않습니다. 계승은 이 확정으로만 일어납니다. NPC 장수는 수명이 다하면 월
        정산에서 자동으로 계승합니다.
      </p>
    </>
  );
}

type HistoryRow = { key: string; tick: number; kind: string; text: string };

function HistoryTab({ ctx }: { ctx: Ctx }) {
  const { view, when } = ctx;
  const name = (id: number) => personName(view, id);
  const rows: HistoryRow[] = [];
  for (const person of view.people) {
    if (person.bornTick !== null && person.parents.length === 2)
      rows.push({
        key: `born:${person.id}`,
        tick: person.bornTick,
        kind: '출생',
        text: `${person.name} 출생 · 가주 ${name(person.parents[0]!)}, 다른 부모 ${name(person.parents[1]!)}`,
      });
    if (person.exit)
      rows.push({
        key: `exit:${person.id}`,
        tick: person.exit.tick,
        kind: person.exit.cause === 'DIED' ? '사망' : '계승',
        text:
          person.exit.cause === 'DIED'
            ? `${person.name} 사망${person.successorId !== null ? ` · ${name(person.successorId)}이(가) 이음` : ''}`
            : `${person.name} 은퇴 · ${person.successorId !== null ? name(person.successorId) : '후계자'}이(가) 이음`,
      });
  }
  for (const row of view.marriages)
    rows.push({
      key: `marriage:${row.id}`,
      tick: row.sinceTick,
      kind: '혼인',
      text: `${name(row.a)}·${name(row.b)} 혼인 · 가주 ${name(row.householdGeneralId)}`,
    });
  rows.sort((a, b) => b.tick - a.tick || a.key.localeCompare(b.key));
  const columns: Column<HistoryRow>[] = [
    { key: 'tick', label: '연월', sortValue: (row) => row.tick, render: (row) => when(row.tick) },
    { key: 'kind', label: '구분', render: (row) => row.kind },
    { key: 'text', label: '내용', render: (row) => row.text },
  ];
  return (
    <>
      {rows.length ? (
        <DataTable
          caption="가문 기록 (공개)"
          rows={rows}
          columns={columns}
          rowKey={(row) => row.key}
          mobileDetails={['kind']}
        />
      ) : (
        <p className={base.note}>아직 공개된 출생·사망·계승·혼인 기록이 없습니다.</p>
      )}
      <p className={base.note}>
        지금 남은 인물과 혼인에서 만든 공개 기록입니다. 끝난 혼인 제안, 후계 지정, 금액은 보이지 않습니다. 공석·청구는
        국가 기록에 남습니다.
      </p>
    </>
  );
}

function confirmText(
  view: LineageView,
  payload: LineageInput,
  when: When,
): Pick<Confirm, 'title' | 'ok' | 'danger' | 'lines' | 'ack'> {
  const recheck = '처리할 때 조건을 다시 판정합니다. 그사이 바뀌면 거부됩니다.';
  const me = view.actorId === null ? '내 장수' : personName(view, view.actorId);
  const household = (id: number) =>
    `가주 문구 · 자녀는 출생 때 가주(제안한 장수 ${personName(view, id)})의 국가·도시를 따르고 가주의 성씨를 잇습니다. 가주는 성별과 관계없이 제안한 쪽입니다.`;
  switch (payload.type) {
    case 'marriage.propose':
      return {
        title: '혼인 제안',
        ok: '혼인 요청 보내기',
        danger: false,
        ack: null,
        lines: [
          `상대: ${personName(view, payload.targetGeneralId)}`,
          household(view.actorId ?? payload.targetGeneralId),
          proposalRule(view, payload.targetGeneralId),
          recheck,
        ],
      };
    case 'marriage.respond': {
      const offer = view.mine?.offers.find((row) => row.id === payload.offerId);
      if (!payload.accept || !offer)
        return {
          title: '혼인 제안 거절',
          ok: '거절 보내기',
          danger: false,
          ack: null,
          lines: [`${offer ? personName(view, offer.fromId) : '상대'}의 제안을 거절합니다. 이 제안은 지워집니다.`],
        };
      const city = offerHouseholdCity(view, offer);
      return {
        title: '혼인 제안 수락',
        ok: '수락 보내기',
        danger: false,
        ack: null,
        lines: [
          `제안한 장수: ${personName(view, offer.fromId)} · 기한 ${when(offer.expiresTick)}`,
          household(offer.householdGeneralId),
          ...(city === null ? [] : [`가주의 지금 도시: ${city} · 출생 때 가주가 있는 도시로 다시 정합니다.`]),
          '수락이 곧 이 문구에 대한 동의입니다. 처리할 때 자격을 다시 판정하고 맞으면 바로 혼인합니다.',
        ],
      };
    }
    case 'heir.designate':
      return payload.heirGeneralId === null
        ? {
            title: '후계 지정 해제',
            ok: '해제 보내기',
            danger: false,
            ack: null,
            lines: [`${personName(view, view.mine?.heirId ?? null)}의 후계 지정을 해제합니다.`],
          }
        : {
            title: '후계자 지정',
            ok: '지정 보내기',
            danger: false,
            ack: null,
            lines: [
              `후계자: ${personName(view, payload.heirGeneralId)}`,
              '지정해도 바로 계승되지 않습니다. 계승은 미리보기를 확인한 뒤 직접 확정해야 일어납니다.',
              '지정은 나만 봅니다. 언제든 바꾸거나 해제할 수 있습니다.',
            ],
          };
    case 'succession.confirm':
      return {
        title: `계승 확정 · ${me} → ${personName(view, payload.heirGeneralId)}`,
        ok: '계승 확정 보내기',
        danger: true,
        ack: `${me}은(는) 은퇴하고 되돌릴 수 없음을 확인했습니다.`,
        lines: [
          '아래 미리보기가 그대로 보내는 내용입니다. 처리할 때 결과가 조금이라도 다르면 계승하지 않습니다.',
          <PreviewList key="preview" view={view} preview={payload.expected} />,
        ],
      };
    case 'ruler.claim': {
      const nation = nationOf(view, payload.nationId)?.name ?? `국가 ${payload.nationId}`;
      const level = view.mine?.claim?.currentOfficerLevel;
      return {
        title: `${nation} 군주 청구`,
        ok: '청구 보내기',
        danger: true,
        ack: `${nation}의 군주가 되는 것에 동의합니다.`,
        lines: [
          `지금 직책${level === undefined ? '' : `(${officerName(level)})`}을 떠납니다.`,
          `${nation}이(가) 사람 국가로 바뀝니다. 이후 조약 자동 응답이 멈춥니다.`,
          '국가 예턴의 군주 칸이 내 칸이 됩니다.',
          '금·쌀·병력·휘하는 바뀌지 않습니다.',
          '같은 국가의 다른 사람 장수도 청구할 수 있습니다. 먼저 처리된 청구 하나만 적용되고 월 정산이 NPC로 먼저 채우면 이 청구는 거부됩니다.',
        ],
      };
    }
  }
}

// 확인 대화상자. 초점을 안에 가두고 Escape로 닫으며, 닫으면 연 단추로 초점을 돌린다(호출 쪽).
function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: (send: boolean) => void }) {
  const titleId = useId(),
    bodyId = useId();
  const box = useRef<HTMLDivElement>(null),
    ok = useRef<HTMLButtonElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const [acked, setAcked] = useState(false);
  const ready = confirm.ack === null || acked;
  useEffect(() => {
    (confirm.danger || confirm.ack ? cancel : ok).current?.focus();
  }, [confirm.danger, confirm.ack]);
  return (
    <div className={base.backdrop}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={confirm.danger ? `${base.dialog} ${base.dangerDialog}` : base.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose(false);
          }
          if (event.key === 'Tab') {
            const items = [...(box.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])];
            if (!items.length) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement as HTMLElement);
            items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length]!.focus();
          }
        }}
      >
        <h2 id={titleId} className={base.dialogTitle}>
          {confirm.title}
        </h2>
        <div id={bodyId} className={base.dialogBody}>
          {confirm.lines.map((line, index) => (typeof line === 'string' ? <p key={index}>{line}</p> : line))}
        </div>
        {confirm.ack ? (
          <label className={styles.ack}>
            <input
              type="checkbox"
              className={styles.check}
              checked={acked}
              onChange={(event) => setAcked(event.target.checked)}
            />
            <span>{confirm.ack}</span>
          </label>
        ) : null}
        <div className={base.row}>
          <button
            ref={ok}
            type="button"
            className={confirm.danger ? base.danger : base.primary}
            disabled={!ready}
            onClick={() => ready && onClose(true)}
          >
            {confirm.ok}
          </button>
          <button ref={cancel} type="button" className={base.secondary} onClick={() => onClose(false)}>
            그만두기
          </button>
        </div>
      </div>
    </div>
  );
}
