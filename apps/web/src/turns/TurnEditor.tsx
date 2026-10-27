import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { emptySlotLabel } from '../policy/policyText';
import { usePolicyQuery } from '../policy/usePolicy';
import { TRADE_COMMAND_KEY } from '../diplomacy/contract';
import { useTradeCityChoices } from '../diplomacy/tradeTargets';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState } from '../ui/States';
import { errorCode, retryUnlessClientError } from './apiError';
import { describeArgs, type ArgNames } from './args';
import { CommandPicker, type CommandInfo } from './CommandPicker';
import {
  describeSelection,
  EMPTY,
  quickSelect,
  rangeBetween,
  repeatRange,
  toTurn,
  turnKey,
  type QuickSelect,
  type Turn,
} from './draft';
import { slotTimes, type SlotTime } from './schedule';
import { personalSource, type Check, type DisplaySlot, type TurnSource, type TurnSourceFactory } from './source';
import styles from './TurnEditor.module.css';
import { useStoredSelection, useTurnDraft, type TurnDraftState } from './useTurnDraft';

const ENDED_REASON = '끝난 판이라 예턴을 바꿀 수 없습니다.';

const HOME_POLL_MS = 15_000;

// 예턴 편집기와 예턴 화면 최근 결과의 home.get 주기. 끝난 판이거나 직전 응답이 NOT_FOUND(내 장수 없음)면 멈춘다.
// 같은 쿼리를 관찰하는 위쪽 띠가 상태·모드 전환 때 한 번 무효화하므로 그때 성공하면 주기가 다시 켜진다 (T1-27).
export function homePollMs(ended: boolean) {
  return (query: { state: { error: unknown } }): number | false =>
    ended || errorCode(query.state.error) === 'NOT_FOUND' ? false : HOME_POLL_MS;
}

export interface TurnEditorProps<S extends DisplaySlot = DisplaySlot> {
  worldId: string;
  // 메인 지도에서 고른 도시(city.key). 대상 도시 칸의 기본값으로만 쓴다. 권한 근거가 아니며 편집을 바꾸거나 저장하지 않는다.
  selectedCityKey: number | null;
  // 칸 수와 조회·저장 연결. 없으면 개인 30칸(turns.*)이다. 국가 직책 12칸은 nationTurns.*를 넘긴다 (T2-06).
  source?: TurnSourceFactory<S>;
  // 편집기 위에 같은 초안 훅 상태를 쓰는 부품을 둔다(작전 맞추기, T2-12). 훅을 하나만 두어야 초안이 갈라지지 않는다.
  renderTop?: ((draft: TurnDraftState) => ReactNode) | undefined;
}

// 예턴 편집기. 메인 명령 칸(T1-16)과 /w/:worldId/turns가 개인 30칸으로, 국가 예턴(T2-06)이 직책 12칸으로 같은 부품을 쓴다.
// 편집 초안·revision·선택·충돌 처리는 이 안에서 한다. 바깥에서 지도 선택이 바뀌거나 조회가 다시 돌아도 초안은 그대로다.
// 개인 칸과 넘겨받은 칸은 칸 모양이 달라 갈래를 나눠 넘긴다. 두 갈래 모두 같은 SourceEditor다.
export function TurnEditor<S extends DisplaySlot>({ source, ...props }: TurnEditorProps<S>) {
  return source ? <SourceEditor {...props} source={source} /> : <SourceEditor {...props} source={personalSource} />;
}

function SourceEditor<S extends DisplaySlot>({
  worldId,
  selectedCityKey,
  source,
  renderTop,
}: Omit<TurnEditorProps<S>, 'source'> & { source: TurnSourceFactory<S> }) {
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.auth.me.queryOptions(), retry: retryUnlessClientError });
  const userId = me.data?.user?.id;
  const made = useMemo(() => (userId ? source({ trpc, userId, worldId }) : null), [source, trpc, userId, worldId]);
  if (!made) {
    if (me.data && !me.data.user) return <AuthLost />;
    if (me.isError) return <ErrorState title="불러오지 못했습니다" onRetry={() => void me.refetch()} />;
    return <p className={styles.muted}>예턴을 불러오는 중…</p>;
  }
  return (
    <Editor
      key={made.storageKey}
      worldId={worldId}
      selectedCityKey={selectedCityKey}
      source={made}
      renderTop={renderTop}
    />
  );
}

function AuthLost() {
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <div className={styles.alert} role="alert">
      <p>로그인이 풀렸습니다. 같은 계정으로 다시 로그인하면 저장하지 않은 편집을 이어서 저장할 수 있습니다.</p>
      <Link to="/login" search={{ next: href }}>
        다시 로그인
      </Link>
    </div>
  );
}

type PrecheckResult = Check | { ok: 'error'; message: string } | undefined;

function Editor<S extends DisplaySlot>({
  worldId,
  selectedCityKey,
  source,
  renderTop,
}: {
  worldId: string;
  selectedCityKey: number | null;
  source: TurnSource<S>;
  renderTop?: TurnEditorProps['renderTop'];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useTurnDraft(worldId, source);
  const { server, turns, serverTurns, draft, pending, notice } = state;
  const slotCount = source.slotCount;
  const readOnly = source.readOnly;

  const commands = useQuery({
    queryKey: source.commands.queryKey,
    queryFn: source.commands.queryFn,
    select: source.commands.select,
    staleTime: Infinity,
    retry: retryUnlessClientError,
  });
  const map = useQuery({
    ...trpc.world.map.queryOptions({ worldId }),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
  const summary = useQuery({ ...trpc.world.summary.queryOptions({ worldId }), retry: retryUnlessClientError });
  // 끝난 판은 예턴을 바꿀 수 없다. 서버도 거부하므로 화면은 막고 이유만 보여 주며 주기 조회도 멈춘다 (T1-27).
  const ended = summary.data?.status === 'ENDED';
  const home = useQuery({
    ...trpc.home.get.queryOptions({ worldId }),
    refetchInterval: homePollMs(ended),
    retry: retryUnlessClientError,
  });
  // 빈 칸이 실제로 무엇을 할지 보여 주려고 지금 방침을 읽는다. 못 읽으면 빈 칸은 휴식으로 보인다.
  const policy = usePolicyQuery(worldId);
  const emptyLabel = emptySlotLabel(policy.data);

  const [selected, setSelected] = useStoredSelection(source.storageKey);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const [shiftBy, setShiftBy] = useState('1');
  const [times, setTimes] = useState('1');
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const helpId = useId();

  // 서버 목록이 바뀌면(저장·턴 실행) 사전 검사도 새로 받는다. 장수 상태가 바뀌었을 수 있다.
  const revision = server.data?.revision;
  const precheckRoot = source.precheckRoot;
  useEffect(() => {
    if (revision !== undefined) void queryClient.invalidateQueries({ queryKey: precheckRoot });
  }, [revision, queryClient, precheckRoot]);

  const commandList: CommandInfo[] = useMemo(() => commands.data ?? [], [commands.data]);
  // 교역 명령의 대상 도시는 교역 조약이 있는 이웃 도시만 후보로 둔다 (T2-08). 저장은 이 편집기의 같은 경로로 한다.
  const cityChoicesFor = useTradeCityChoices(
    worldId,
    commandList.some((c) => c.key === TRADE_COMMAND_KEY),
  );
  const commandName = useCallback(
    (key: string) => commandList.find((c) => c.key === key)?.name ?? (key === 'rest' ? '휴식' : key),
    [commandList],
  );
  const cities = useMemo(() => map.data?.cities ?? [], [map.data]);
  const nations = useMemo(() => map.data?.nations ?? [], [map.data]);
  const generals = source.generals;
  const names = useMemo(
    () => ({
      city: (key: number) => cities.find((c) => c.key === key)?.name,
      nation: (id: number) => nations.find((n) => n.id === id)?.name,
      general: generals ? (id: number) => generals.find((g) => g.id === id)?.name : undefined,
    }),
    [cities, nations, generals],
  );

  // 같은 명령·인자는 사전 검사를 한 번만 묻는다. 휴식은 묻지 않는다.
  // 읽기 전용 칸은 내 상태로 검사할 수 없으므로 묻지 않는다.
  const distinct = useMemo(() => {
    const seen = new Map<string, Turn>();
    if (readOnly === null)
      for (const turn of turns ?? []) if (turn.explicit && turn.commandKey !== 'rest') seen.set(turnKey(turn), turn);
    return [...seen.entries()];
  }, [turns, readOnly]);
  const prechecks = useQueries({
    queries: distinct.map(([, turn]) => {
      const check = source.precheck(turn);
      return {
        queryKey: check.queryKey,
        queryFn: check.queryFn,
        select: check.select,
        staleTime: 15_000,
        retry: retryUnlessClientError,
      };
    }),
  });
  const precheckByKey = new Map<string, PrecheckResult>();
  distinct.forEach(([key], i) => {
    const query = prechecks[i];
    if (!query) return;
    if (query.data) precheckByKey.set(key, query.data);
    else if (query.isError)
      precheckByKey.set(key, {
        ok: 'error',
        message: errorCode(query.error) === 'BAD_REQUEST' ? '명령과 인자를 확인하세요.' : '검사하지 못했습니다.',
      });
  });

  const times30: SlotTime[] = source.timed
    ? slotTimes(slotCount, summary.data, home.data?.general.nextTurnTick, home.data?.nextTurnAt)
    : Array.from({ length: slotCount }, () => ({ date: null, time: null, iso: null }));

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(slotCount - 1, i));
    setFocus(next);
    rowRefs.current[next]?.focus();
  };

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const addRange = (from: number, to: number) => setSelected((prev) => new Set([...prev, ...rangeBetween(from, to)]));

  const onRowClick = (event: MouseEvent, i: number) => {
    if (event.shiftKey && anchor !== null) addRange(anchor, i);
    else {
      toggle(i);
      setAnchor(i);
    }
    setFocus(i);
  };

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const next = key === 'ArrowDown' ? focus + 1 : key === 'ArrowUp' ? focus - 1 : key === 'Home' ? 0 : slotCount - 1;
      const clamped = Math.max(0, Math.min(slotCount - 1, next));
      if (event.shiftKey) addRange(anchor ?? focus, clamped);
      focusRow(clamped);
    } else if (key === ' ') {
      event.preventDefault();
      toggle(focus);
      setAnchor(focus);
    } else if (key === 'Enter') {
      event.preventDefault();
      if (selected.size === 0) setSelected(new Set([focus]));
      searchRef.current?.focus();
    } else if (key === 'Escape') {
      setSelected(new Set());
    }
  };

  const busyReason = ended
    ? ENDED_REASON
    : state.saving
      ? '저장하는 중입니다.'
      : pending
        ? '먼저 위 충돌 안내에서 다시 적용할지 고르세요.'
        : !server.data
          ? '예턴을 불러온 뒤에 고칠 수 있습니다.'
          : null;
  const putBlocked = busyReason ?? (selected.size === 0 ? '칸을 먼저 고르세요.' : null);
  const shiftN = Number(shiftBy);
  const shiftOk = Number.isInteger(shiftN) && shiftN >= 1 && shiftN <= slotCount - 1;
  const repeat = repeatRange(selected, slotCount);
  const timesN = Number(times);
  const timesOk = Number.isInteger(timesN) && timesN >= 1 && timesN <= slotCount - 1;
  const repeatReason =
    busyReason ??
    (!repeat
      ? `이어진 칸 한 구간을 고르세요. ${slotCount}번 칸에서 끝나는 구간은 반복할 자리가 없습니다.`
      : !timesOk
        ? `반복 횟수는 1~${slotCount - 1}입니다.`
        : null);

  const onPut = (turn: Turn) => {
    if (putBlocked) return;
    state.edit({ put: { indices: [...selected].sort((a, b) => a - b), turn } });
    rowRefs.current[focus]?.focus();
  };
  const onClear = () => onPut(EMPTY);

  if (!turns) {
    if (state.authLost) return <AuthLost />;
    if (server.isError) {
      const code = errorCode(server.error);
      if (code === 'NOT_FOUND')
        return (
          <EmptyState title="이 월드에 내 장수가 없습니다">
            <Link to="/w/$worldId/create" params={{ worldId }}>
              장수 만들기
            </Link>
          </EmptyState>
        );
      if (code === 'BAD_REQUEST') return <EmptyState title="월드를 찾을 수 없습니다" />;
      return <ErrorState title="예턴을 불러오지 못했습니다" onRetry={() => void server.refetch()} />;
    }
    return <p className={styles.muted}>예턴을 불러오는 중…</p>;
  }

  const editCount = draft?.ops.length ?? 0;
  const selectionText = selected.size === 0 ? '없음' : `${describeSelection(selected)}번 칸`;
  const targetLabel = selected.size === 0 ? '고른 칸' : `${describeSelection(selected)}번 칸`;

  if (readOnly !== null)
    return (
      <div className={styles.editor} data-testid="turn-editor" data-readonly="true">
        <p className={styles.saveState} data-testid="readonly-reason">
          읽기 전용: {readOnly}
        </p>
        <ReadOnlySlots label={source.gridLabel} slots={server.data?.slots ?? []} times={times30} names={names} />
      </div>
    );

  return (
    <div className={styles.editor} data-testid="turn-editor">
      {renderTop?.(state)}
      <div className={styles.saveBar}>
        <p className={styles.saveState} data-testid="draft-state">
          {editCount > 0 ? `저장하지 않은 편집 ${editCount}건` : '저장된 목록'}
        </p>
        {draft && !state.saving && !ended ? (
          <button type="button" className={styles.primary} onClick={state.submit}>
            저장
          </button>
        ) : (
          <DisabledReason reason={ended ? ENDED_REASON : state.saving ? '저장하는 중입니다.' : '바꾼 칸이 없습니다.'}>
            저장
          </DisabledReason>
        )}
        {draft ? (
          <button type="button" className={styles.secondary} onClick={state.discard} disabled={state.saving}>
            편집 취소
          </button>
        ) : null}
      </div>

      {ended ? (
        <p className={styles.muted} data-testid="turns-locked">
          {ENDED_REASON}
        </p>
      ) : null}
      <div role="status" className={styles.notice}>
        {state.saving ? '저장하는 중…' : null}
        {notice?.kind === 'saved' ? '저장했습니다.' : null}
        {notice?.kind === 'reapplied' ? '최신 목록에 내 편집을 다시 적용했습니다. 확인한 뒤 저장하세요.' : null}
        {state.behind && !pending
          ? '다른 곳에서 예턴이 바뀌었습니다(다른 탭 저장이나 턴 실행). 저장하면 최신 목록에 다시 적용할지 묻습니다.'
          : null}
      </div>
      {notice?.kind === 'error' ? (
        <p className={styles.errorText} role="alert">
          {notice.message}
        </p>
      ) : null}
      {state.authLost ? <AuthLost /> : null}
      {pending ? (
        <div className={styles.alert} role="alert" data-testid="stale-alert">
          <p>다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.</p>
          <p>내 편집 {pending.ops.length}건은 버리지 않고 보관했습니다. 최신 목록에 다시 적용할까요?</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.primary} onClick={state.reapply}>
              내 편집 다시 적용
            </button>
            <button type="button" className={styles.secondary} onClick={state.discard}>
              내 편집 버리기
            </button>
          </div>
        </div>
      ) : null}

      <div className={styles.selectBar} role="group" aria-label="칸 고르기">
        <span data-testid="selection">선택: {selectionText}</span>
        {(['all', 'odd', 'even'] as QuickSelect[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={styles.chip}
            onClick={() => {
              setSelected(quickSelect(kind, slotCount));
              setAnchor(null);
            }}
          >
            {kind === 'all' ? '전체' : kind === 'odd' ? '홀수 칸' : '짝수 칸'}
          </button>
        ))}
        <button
          type="button"
          className={styles.chip}
          onClick={() => {
            setSelected(new Set());
            setAnchor(null);
          }}
        >
          선택 해제
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table
          className={styles.table}
          role="grid"
          aria-multiselectable="true"
          aria-label={source.gridLabel}
          aria-describedby={helpId}
          onKeyDown={onGridKey}
        >
          <thead>
            <tr>
              <th scope="col" className="num">
                칸
              </th>
              <th scope="col">실행 시기</th>
              <th scope="col">명령</th>
              <th scope="col">사전 검사</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn, i) => {
              const isSelected = selected.has(i);
              const changed = !!draft && !pending && !!serverTurns && turnKey(serverTurns[i]!) !== turnKey(turn);
              const check = turn.commandKey === 'rest' ? undefined : precheckByKey.get(turnKey(turn));
              const isEmpty = !turn.explicit;
              const args = describeArgs(turn.args, names);
              const time = times30[i]!;
              return (
                <tr
                  key={i}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  aria-selected={isSelected}
                  aria-rowindex={i + 2}
                  tabIndex={focus === i ? 0 : -1}
                  className={[styles.row, isSelected ? styles.selected : '', changed ? styles.changed : '']
                    .filter(Boolean)
                    .join(' ')}
                  data-slot={i + 1}
                  data-empty={isEmpty ? 'true' : undefined}
                  onClick={(e) => onRowClick(e, i)}
                  onFocus={() => setFocus(i)}
                >
                  <td className="num" role="gridcell">
                    {i + 1}
                  </td>
                  <td role="gridcell" className={styles.when}>
                    <span>{time.date ?? '—'}</span>
                    {time.time ? <time dateTime={time.iso ?? undefined}>{time.time}</time> : null}
                  </td>
                  <td role="gridcell">
                    {isEmpty ? (
                      <span className={styles.emptySlot} title="비워 둔 칸입니다. 기본 방침대로 실행합니다.">
                        ({emptyLabel.tag}) {emptyLabel.command}
                      </span>
                    ) : (
                      <span className={styles.command}>{commandName(turn.commandKey)}</span>
                    )}
                    {args ? <span className={styles.args}> {args}</span> : null}
                    {changed ? <span className={styles.changedTag}>바뀜</span> : null}
                  </td>
                  <td role="gridcell" className={styles.check}>
                    {check === undefined ? (
                      turn.commandKey === 'rest' ? (
                        <span className={styles.muted}>—</span>
                      ) : (
                        <span className={styles.muted}>검사 중</span>
                      )
                    ) : check.ok === true ? (
                      <span className={styles.ok}>가능</span>
                    ) : (
                      <span className={styles.warn}>경고: {check.message}</span>
                    )}
                    {check && check.ok !== 'error' && check.preview ? (
                      <span className={styles.args}>
                        금 {check.preview.goldCost.toLocaleString()}
                        {check.preview.statScore !== undefined ? ` · 능력치 점수 ${check.preview.statScore}` : ''}
                        {check.preview.gain !== undefined ? ` · 상승 ${check.preview.gain}` : ''}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p id={helpId} className={styles.help}>
        칸을 누르면 고르거나 풉니다. Shift를 누른 채 누르면 범위를 고릅니다. 키보드는 위아래 화살표로 옮기고 Space로
        고르며 Enter로 명령 찾기에 갑니다. 경고가 있어도 저장되며 실행할 때 다시 검사합니다.
      </p>

      {commands.isError ? (
        <ErrorState title="명령 목록을 불러오지 못했습니다" onRetry={() => void commands.refetch()} />
      ) : (
        <CommandPicker
          commands={commandList}
          cities={cities}
          nations={nations}
          selectedCityKey={selectedCityKey}
          generals={generals}
          defaultCrewType={home.data?.general.crewType}
          blockedReason={putBlocked}
          targetLabel={targetLabel}
          searchRef={searchRef}
          onPut={onPut}
          cityChoicesFor={cityChoicesFor}
        />
      )}

      <div className={styles.editBar} role="group" aria-label="칸 옮기기와 반복">
        {putBlocked ? (
          <DisabledReason reason={putBlocked}>고른 칸 비우기</DisabledReason>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            title="고른 칸을 빈 칸으로 되돌립니다. 빈 칸은 기본 방침대로 실행합니다"
            onClick={onClear}
          >
            고른 칸 비우기
          </button>
        )}
        <label className={styles.inline}>
          <span>칸 수</span>
          <input
            type="number"
            className="num"
            min={1}
            max={slotCount - 1}
            value={shiftBy}
            onChange={(e) => setShiftBy(e.target.value)}
          />
        </label>
        {busyReason || !shiftOk ? (
          <>
            <DisabledReason reason={busyReason ?? `칸 수는 1~${slotCount - 1}입니다.`}>당기기</DisabledReason>
            <DisabledReason reason={busyReason ?? `칸 수는 1~${slotCount - 1}입니다.`}>밀기</DisabledReason>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.secondary}
              title="모든 칸을 앞으로 당기고 끝을 빈 칸으로 채웁니다"
              onClick={() => state.edit({ shift: -shiftN })}
            >
              당기기
            </button>
            <button
              type="button"
              className={styles.secondary}
              title="모든 칸을 뒤로 밀고 앞을 빈 칸으로 채웁니다"
              onClick={() => state.edit({ shift: shiftN })}
            >
              밀기
            </button>
          </>
        )}
        <label className={styles.inline}>
          <span>반복 횟수</span>
          <input
            type="number"
            className="num"
            min={1}
            max={slotCount - 1}
            value={times}
            onChange={(e) => setTimes(e.target.value)}
          />
        </label>
        {repeatReason || !repeat ? (
          <DisabledReason reason={repeatReason ?? ''}>고른 구간 반복</DisabledReason>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            title="고른 구간을 바로 뒤에 횟수만큼 이어 붙입니다"
            onClick={() => state.edit({ repeat: { ...repeat, times: timesN } })}
          >
            고른 구간 반복
          </button>
        )}
      </div>
    </div>
  );
}

// 남의 직책 칸(T2-06). 명령 이름은 서버가 칸에 실어 준 것을 쓴다. 내 직책이 못 쓰는 명령도 이름이 보인다.
function ReadOnlySlots({
  label,
  slots,
  times,
  names,
}: {
  label: string;
  slots: Array<{ commandKey: string; args?: unknown; name: string }>;
  times: SlotTime[];
  names: ArgNames;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className="num">
              칸
            </th>
            <th scope="col">실행 시기</th>
            <th scope="col">명령</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((slot, i) => {
            const args = describeArgs(toTurn(slot).args, names);
            const time = times[i];
            return (
              <tr key={i} className={styles.row} data-slot={i + 1}>
                <td className="num">{i + 1}</td>
                <td className={styles.when}>
                  <span>{time?.date ?? '—'}</span>
                </td>
                <td>
                  <span className={styles.command}>{slot.name}</span>
                  {args ? <span className={styles.args}> {args}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
