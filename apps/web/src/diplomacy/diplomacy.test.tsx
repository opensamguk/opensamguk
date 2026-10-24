// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPicker } from '../turns/CommandPicker';
import { readSelection, selectionStorageKey, writeSelection } from '../turns/useTurnDraft';
import { buildClauses, describeClause, emptyCompose, noteLength, type ComposeState } from './clauses';
import type {
  ActionInput,
  Allowed,
  PendingAction,
  RecentAction,
  RequestState,
  TreatyItem,
  TreatyListPage,
} from './contract';
import { busyText, joinTreatyPages, pageCountText, parseDiplomacySearch, treatiesForTab } from './DiplomacyPage';
import {
  applyCheckError,
  applyOutcome,
  applySendError,
  finishedText,
  readTracked,
  recentText,
  requestsStorageKey,
  startRequest,
  writeTracked,
  type RequestsState,
} from './requests';
import { TRADE_UNSUPPORTED } from './tradeTargets';
import { estimateText, nationName, paidText, TreatyCard } from './TreatyCard';

afterEach(cleanup);

// 실제 AppRouter treaty.list 출력 타입으로 만든 시험용 조약. 타입에 없는 칸(신의·남은 개월·파기)은 넣을 수 없다.
// 이 값은 손으로 만든 것이고 실제 서버 실행의 증거가 아니다.
const nation = (id: number, name: string) => ({ id, name, color: '#336699' });
const ok: Allowed = { ok: true };
const treaty = (patch: Partial<TreatyItem> = {}): TreatyItem => ({
  id: '7',
  fromNationId: 2,
  toNationId: 1,
  incoming: true,
  clauses: [
    { kind: 'nonAggression', months: 24 },
    { kind: 'note', text: '서로 사신을 보낸다' },
  ],
  status: 'PROPOSED',
  proposedTick: 100,
  respondByTick: 700,
  startTick: null,
  endTick: null,
  cost: null,
  from: nation(2, '원소'),
  to: nation(1, '조조'),
  proposedAt: { year: 191, month: 3 },
  respondBy: { year: 191, month: 9 },
  startAt: null,
  endAt: null,
  estimate: { mine: 1200, theirs: 900 },
  canAccept: ok,
  canReject: ok,
  ...patch,
});
const page = (items: TreatyItem[], nextCursor: string | null): TreatyListPage => ({
  canPropose: ok,
  targets: [],
  items,
  nextCursor,
  pending: [],
  myRecent: [],
});

describe('조약서 조항', () => {
  const form = (patch: Partial<ComposeState>): ComposeState => ({ ...emptyCompose(), toNationId: 2, ...patch });

  it('첫 세 조항만 서버 저장 순서로 만든다', () => {
    const built = buildClauses(
      form({ peace: true, nonAggression: { on: true, months: '24' }, note: { on: true, text: ' 사신을 보낸다 ' } }),
      'WAR',
    );
    expect(built.problems).toEqual([]);
    expect(built.clauses).toEqual([
      { kind: 'peace' },
      { kind: 'nonAggression', months: 24 },
      { kind: 'note', text: '사신을 보낸다' },
    ]);
  });

  it('종전은 교전·선포 상대에게만 넣는다', () => {
    expect(buildClauses(form({ peace: true }), 'WAR').clauses).toEqual([{ kind: 'peace' }]);
    expect(buildClauses(form({ peace: true }), 'DECLARED').problems).toEqual([]);
    const none = buildClauses(form({ peace: true }), 'NON_AGGRESSION');
    expect(none.clauses).toEqual([]);
    expect(none.problems[0]).toContain('종전');
  });

  it('범위 밖 기간, 빈·긴 약속, 상대 없음, 조항 없음은 보내기 전에 막는다', () => {
    expect(buildClauses(form({ nonAggression: { on: true, months: '121' } }), 'NONE').problems).toEqual([
      '불가침 기간은 1~120개월입니다.',
    ]);
    expect(buildClauses(form({ note: { on: true, text: '  ' } }), 'NONE').problems).toEqual([
      '기록만 남길 약속의 문장을 쓰세요.',
    ]);
    expect(buildClauses({ ...emptyCompose(), note: { on: true, text: '약속' } }, undefined).problems).toEqual([
      '상대 국가를 고르세요.',
    ]);
    expect(buildClauses(form({}), 'NONE').problems).toEqual(['조항을 하나 이상 고르세요.']);
    expect(buildClauses(form({ note: { on: true, text: 'x'.repeat(301) } }), 'NONE').problems).toEqual([
      '약속 문장은 300자까지입니다.',
    ]);
  });

  it('약속 길이는 서버처럼 NFC 코드포인트로 센다', () => {
    expect(noteLength('😀'.repeat(300))).toBe(300);
    expect(buildClauses(form({ note: { on: true, text: '😀'.repeat(300) } }), 'NONE').problems).toEqual([]);
    expect(noteLength('é')).toBe(1);
  });

  it('조항 요약', () => {
    expect(describeClause({ kind: 'peace' })).toBe('종전');
    expect(describeClause({ kind: 'nonAggression', months: 6 })).toBe('불가침 6개월');
    expect(describeClause({ kind: 'note', text: '사신' })).toBe('기록만 남길 약속 (사신)');
  });
});

describe('즉시 행동 요청 추적', () => {
  const propose: ActionInput = {
    kind: 'treaty.propose',
    input: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 6 }] },
  };
  const accept: ActionInput = { kind: 'treaty.respond', input: { treatyId: '7', accept: true } };
  const decline: ActionInput = { kind: 'treaty.respond', input: { treatyId: '7', accept: false } };
  const empty: RequestsState = { tracked: [], finished: [] };
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
  };

  it('키는 v2이며 계정과 월드를 넣는다. 되살린 요청은 결과를 묻는 상태로 시작한다', () => {
    expect(requestsStorageKey('u1', 'w1')).toBe('opensamguk.treatyRequests.v2:u1:w1');
    expect(requestsStorageKey('u1', 'w1')).not.toBe(requestsStorageKey('u2', 'w1'));
    const storage = memory();
    const state = startRequest(empty, 'r1', propose);
    writeTracked(storage, 'k', state.tracked);
    expect(readTracked(storage, 'k')).toEqual([{ requestId: 'r1', action: propose, phase: 'checking' }]);
    writeTracked(storage, 'k', []);
    expect(storage.getItem('k')).toBeNull();
  });

  it('옛 모양(expiresInMonths, propose·break 종류, 뒤 네 조항)은 되살려 다시 보내지 않는다', () => {
    const storage = memory();
    storage.setItem('k', '{깨진');
    expect(readTracked(storage, 'k')).toEqual([]);
    storage.setItem(
      'k',
      JSON.stringify([
        { requestId: 'a', action: { kind: 'propose', input: { toNationId: 2, clauses: [], expiresInMonths: 6 } } },
        {
          requestId: 'b',
          action: { kind: 'treaty.propose', input: { toNationId: 2, clauses: [], expiresInMonths: 6 } },
        },
        { requestId: 'c', action: { kind: 'break', input: { treatyId: '7' } } },
        { requestId: 'd', action: { kind: 'treaty.propose', input: { toNationId: 2, clauses: [{ kind: 'trade' }] } } },
        { requestId: '', action: accept },
        { requestId: 'e', action: accept },
      ]),
    );
    expect(readTracked(storage, 'k').map((t) => t.requestId)).toEqual(['e']);
  });

  it('pending은 처리 중으로 두고 applied는 엔진 결과(outcome)로 문구를 고른다', () => {
    let state = startRequest(empty, 'r1', accept);
    state = applyOutcome(state, { status: 'pending', requestId: 'r1', kind: 'treaty.respond' });
    expect(state.tracked[0]?.phase).toBe('pending');
    expect(state.finished).toEqual([]);
    state = applyOutcome(state, {
      status: 'applied',
      requestId: 'r1',
      kind: 'treaty.respond',
      outcome: 'ACCEPTED',
      treatyId: '7',
      treaty: null,
    });
    expect(state.tracked).toEqual([]);
    expect(state.finished[0]).toMatchObject({ requestId: 'r1', result: 'applied', outcome: 'ACCEPTED', treaty: null });
    expect(finishedText(state.finished[0]!)).toBe('조약을 맺었습니다.');

    const declined = applyOutcome(startRequest(empty, 'r2', decline), {
      status: 'applied',
      requestId: 'r2',
      kind: 'treaty.respond',
      outcome: 'DECLINED',
      treatyId: '7',
      treaty: null,
    });
    expect(finishedText(declined.finished[0]!)).toBe('제안을 거절했습니다.');
  });

  it('제안한 쪽이 받은 APPLIED DECLINED(NPC 즉시 판단)는 상대가 거절한 것으로 적는다', () => {
    const npcDeclined: RequestState = {
      status: 'applied',
      requestId: 'r3',
      kind: 'treaty.propose',
      outcome: 'DECLINED',
      treatyId: '12',
      treaty: null,
    };
    const declined = applyOutcome(startRequest(empty, 'r3', propose), npcDeclined);
    expect(declined.finished[0]).toMatchObject({ result: 'applied', outcome: 'DECLINED' });
    expect(finishedText(declined.finished[0]!)).toBe('상대가 제안을 거절했습니다.');

    const npcAccepted: RequestState = { ...npcDeclined, requestId: 'r4', outcome: 'ACCEPTED' };
    const accepted = applyOutcome(startRequest(empty, 'r4', propose), npcAccepted);
    expect(finishedText(accepted.finished[0]!)).toBe('상대가 제안을 받아 조약을 맺었습니다.');
  });

  it('HTTP 200의 rejected 값은 엔진 거절로 확정하고 서버 문장을 그대로 보인다', () => {
    const rejected = applyOutcome(startRequest(empty, 'r2', accept), {
      status: 'rejected',
      requestId: 'r2',
      kind: 'treaty.respond',
      code: 'INSUFFICIENT_GOLD',
      reason: '국고가 모자랍니다.',
    });
    expect(rejected.finished[0]).toMatchObject({ result: 'rejected', reason: '국고가 모자랍니다.' });
    expect(finishedText(rejected.finished[0]!)).toBe('수락 요청이 거절되었습니다. 국고가 모자랍니다.');
  });

  it('응답 유실과 INTERNAL_SERVER_ERROR는 접수 여부를 모르는 상태로 둔다. 로그인이 풀리면 requestId를 남긴다', () => {
    const start = startRequest(empty, 'r1', propose);
    expect(applySendError(start, 'r1', undefined, undefined).tracked[0]?.phase).toBe('unknown');
    const internal = applySendError(start, 'r1', 'INTERNAL_SERVER_ERROR', '조약 요청 기록을 확인하지 못했습니다.');
    expect(internal.tracked).toEqual([{ requestId: 'r1', action: propose, phase: 'unknown' }]);
    expect(internal.finished).toEqual([]);
    const auth = applySendError(start, 'r1', 'UNAUTHORIZED', '로그인하세요');
    expect(auth.tracked).toEqual([{ requestId: 'r1', action: propose, phase: 'auth' }]);
  });

  it('접수 단계 거부(같은 대상 처리 중, 형식 1 월드)는 엔진 거절과 다른 문구로 확정한다', () => {
    const start = startRequest(empty, 'r1', propose);
    const conflict = applySendError(start, 'r1', 'CONFLICT', '요청을 처리하는 중입니다.');
    expect(conflict.tracked).toEqual([]);
    expect(conflict.finished[0]?.result).toBe('refused');
    expect(finishedText(conflict.finished[0]!)).toBe('제안 요청을 서버가 받지 않았습니다. 요청을 처리하는 중입니다.');
    const legacy = applySendError(start, 'r1', 'PRECONDITION_FAILED', '조약 기능을 쓰지 않는 월드입니다.');
    expect(finishedText(legacy.finished[0]!)).toBe(
      '제안 요청을 서버가 받지 않았습니다. 조약 기능을 쓰지 않는 월드입니다.',
    );
  });

  it('결과 조회에서 NOT_FOUND는 다시 보내기, 연결 실패·내부 오류는 그대로 다시 묻기', () => {
    const checking: RequestsState = { tracked: [{ requestId: 'r1', action: accept, phase: 'checking' }], finished: [] };
    expect(applyCheckError(checking, 'r1', 'NOT_FOUND').tracked[0]?.phase).toBe('unknown');
    expect(applyCheckError(checking, 'r1', 'UNAUTHORIZED').tracked[0]?.phase).toBe('auth');
    expect(applyCheckError(checking, 'r1', undefined)).toBe(checking);
    expect(applyCheckError(checking, 'r1', 'INTERNAL_SERVER_ERROR')).toBe(checking);
  });

  it('카드 처리 중 안내는 내 요청이 먼저, 없으면 같은 국가 다른 장수의 respond 대기 요청', () => {
    const tracked = startRequest(empty, 'r1', accept).tracked;
    expect(busyText('7', tracked, [])).toBe('수락 보내는 중');
    const other: PendingAction[] = [
      {
        requestId: null,
        kind: 'treaty.respond',
        treatyId: '8',
        toNation: null,
        accept: true,
        requestedBy: { name: '순욱' },
      },
      {
        requestId: null,
        kind: 'treaty.propose',
        treatyId: null,
        toNation: nation(3, '유표'),
        accept: null,
        requestedBy: { name: '정욱' },
      },
    ];
    expect(busyText('8', tracked, other)).toBe('순욱의 요청을 처리하는 중입니다.');
    expect(busyText('9', tracked, other)).toBeNull();
  });

  it('최근 처리된 내 요청은 DECLINED를 누가 거절했는지에 맞춰 적고 엔진 거절은 이유와 함께 적는다', () => {
    const recent = (patch: Partial<RecentAction>): RecentAction => ({
      requestId: 'r',
      kind: 'treaty.respond',
      treatyId: '7',
      result: 'APPLIED',
      outcome: 'DECLINED',
      reason: null,
      ...patch,
    });
    expect(recentText(recent({}))).toBe('응답 · 받은 제안을 거절함');
    expect(recentText(recent({ outcome: 'ACCEPTED' }))).toBe('응답 · 수락해 조약을 맺음');
    expect(recentText(recent({ kind: 'treaty.propose', outcome: 'PROPOSED' }))).toBe('제안 · 제안을 보냄');
    expect(recentText(recent({ kind: 'treaty.propose', outcome: 'DECLINED' }))).toBe('제안 · 상대가 거절함');
    expect(recentText(recent({ kind: 'treaty.propose', outcome: 'ACCEPTED' }))).toBe(
      '제안 · 상대가 수락해 조약을 맺음',
    );
    expect(recentText(recent({ result: 'REJECTED', outcome: null, reason: '기한이 지났습니다.' }))).toBe(
      '응답 · 받아들여지지 않음 (기한이 지났습니다.)',
    );
  });
});

describe('외교실 탭과 쪽', () => {
  it('상태별로 나누고 사라진 신의·파기 탭은 받은 제안으로 둔다', () => {
    const items = [
      treaty({ id: 'a' }),
      treaty({ id: 'b', incoming: false }),
      treaty({ id: 'c', status: 'ACTIVE' }),
      treaty({ id: 'd', status: 'EXPIRED' }),
      treaty({ id: 'e', status: 'REJECTED' }),
      treaty({ id: 'f', status: 'ENDED' }),
    ];
    expect(treatiesForTab(items, 'incoming').map((t) => t.id)).toEqual(['a']);
    expect(treatiesForTab(items, 'outgoing').map((t) => t.id)).toEqual(['b']);
    expect(treatiesForTab(items, 'active').map((t) => t.id)).toEqual(['c']);
    expect(treatiesForTab(items, 'ended').map((t) => t.id)).toEqual(['d', 'e', 'f']);
    expect(parseDiplomacySearch({ tab: 'nope' })).toEqual({ tab: 'incoming' });
    expect(parseDiplomacySearch({ tab: 'trust' })).toEqual({ tab: 'incoming' });
    expect(parseDiplomacySearch({ tab: 'broken' })).toEqual({ tab: 'incoming' });
    expect(parseDiplomacySearch({ tab: 'write' })).toEqual({ tab: 'write' });
  });

  it('쪽을 순서대로 잇고 같은 ID는 한 번만 둔다. 탭 수는 불러온 쪽 기준이라고 적는다', () => {
    const joined = joinTreatyPages([
      page([treaty({ id: '9' }), treaty({ id: '8' })], '8'),
      page([treaty({ id: '8' }), treaty({ id: '3' })], null),
    ]);
    expect(joined.map((t) => t.id)).toEqual(['9', '8', '3']);
    expect(pageCountText(30, true)).toBe(
      '탭의 수는 지금까지 불러온 조약 30개만 셉니다. 더 오래된 조약이 남아 있습니다.',
    );
    expect(pageCountText(31, false)).toBe('탭의 수는 불러온 조약 31개를 모두 셉니다.');
  });
});

describe('조약 카드', () => {
  it('받은 제안은 조항을 집행·기록으로 나누고 내 쪽 추정 비용(estimate)을 보인다', () => {
    render(<TreatyCard treaty={treaty()} busy={null} onRespond={vi.fn()} />);
    expect(screen.getByRole('region', { name: '서버가 집행하는 조항' }).textContent).toContain('불가침 24개월');
    expect(screen.getByRole('region', { name: '기록만 남는 조항' }).textContent).toContain('서로 사신을 보낸다');
    expect(screen.getByTestId('treaty-estimate').textContent).toBe(
      '우리 금 1,200 · 상대 금 900 (지금 도시 수 기준, 수락 때 다시 계산)',
    );
    expect(screen.queryByText(/신의|파기/)).toBeNull();
    expect(screen.queryByRole('button', { name: '파기' })).toBeNull();
  });

  it('맺은 조약은 추정이 아니라 실제로 낸 cost.from·to를 당사국 이름과 함께 보인다', () => {
    const active = treaty({
      status: 'ACTIVE',
      estimate: null,
      canAccept: null,
      canReject: null,
      cost: { from: 300, to: 450 },
      startAt: { year: 191, month: 4 },
      endAt: { year: 193, month: 4 },
    });
    render(<TreatyCard treaty={active} busy={null} onRespond={vi.fn()} />);
    expect(screen.getByTestId('treaty-cost-paid').textContent).toBe('원소 금 300 · 조조 금 450');
    expect(screen.queryByTestId('treaty-estimate')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(paidText(active, { from: 300, to: 450 })).toBe('원소 금 300 · 조조 금 450');
  });

  it('당사국이 없으면(null) 이름을 지어내지 않고 ID와 없는 국가를 적으며 추정 비용도 만들지 않는다', () => {
    const missing = treaty({
      from: null,
      fromNationId: 9,
      estimate: null,
      canAccept: { ok: false, code: 'BAD_TARGET', reason: '조약 상대 국가가 없습니다.' },
      canReject: { ok: false, code: 'BAD_TARGET', reason: '조약 상대 국가가 없습니다.' },
    });
    render(<TreatyCard treaty={missing} busy={null} onRespond={vi.fn()} />);
    expect(screen.getByRole('article', { name: '없는 국가 (ID 9)와 조조의 조약' })).toBeTruthy();
    expect(screen.getByTestId('treaty-estimate').textContent).toBe('당사국이 없어 계산하지 않습니다.');
    fireEvent.click(screen.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ }));
    expect(screen.getByRole('note').textContent).toBe('조약 상대 국가가 없습니다.');
    expect(nationName(null, 4)).toBe('없는 국가 (ID 4)');
    expect(estimateText(null)).toBe('당사국이 없어 계산하지 않습니다.');
  });

  it('국고 안내가 막으면 수락만 서버 문장과 함께 잠기고 거절은 그대로 누른다', () => {
    const onRespond = vi.fn();
    render(
      <TreatyCard
        treaty={treaty({ canAccept: { ok: false, code: 'INSUFFICIENT_GOLD', reason: '국고가 모자랍니다.' } })}
        busy={null}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ }));
    expect(screen.getByRole('note').textContent).toBe('국고가 모자랍니다.');
    fireEvent.click(screen.getByRole('button', { name: '거절' }));
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('권한이 없으면 쓰기 단추를 그리지 않고 읽기만 한다고 알린다', () => {
    const denied: Allowed = { ok: false, code: 'NO_PERMISSION', reason: '조약을 처리할 권한이 없습니다.' };
    render(<TreatyCard treaty={treaty({ canAccept: denied, canReject: denied })} busy={null} onRespond={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /수락|거절/ })).toBeNull();
    expect(screen.getByText(/읽기만 합니다/)).toBeTruthy();
  });

  it('처리 중이면 단추를 잠그고 그 안내를 보인다', () => {
    const onRespond = vi.fn();
    render(<TreatyCard treaty={treaty()} busy="수락 처리 중" onRespond={onRespond} />);
    expect(screen.getByRole('status').textContent).toBe('수락 처리 중');
    fireEvent.click(screen.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ }));
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe('예턴 편집의 교역 대상', () => {
  it('교역 대상 조회가 서버에 없으므로 후보 없이 지원하지 않는다는 이유만 보인다', () => {
    const commands = [
      {
        key: 'trade',
        name: '교역',
        category: 'domestic',
        argsSchema: { type: 'object', properties: { cityKey: { type: 'integer' } }, required: ['cityKey'] },
      },
    ];
    render(
      <CommandPicker
        commands={commands}
        cities={[
          { key: 3, name: '진류' },
          { key: 12, name: '복양' },
        ]}
        nations={[]}
        selectedCityKey={3}
        defaultCrewType={undefined}
        blockedReason={null}
        targetLabel="1번 칸"
        searchRef={{ current: null }}
        onPut={vi.fn()}
        cityChoicesFor={(key) => (key === 'trade' ? TRADE_UNSUPPORTED : null)}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '교역' }));
    const select = screen.getByRole('combobox', { name: /대상 도시/ }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['고르세요']);
    expect(screen.getByText(TRADE_UNSUPPORTED.note!)).toBeTruthy();
  });
});

describe('고른 칸 보관', () => {
  it('외교실에 갔다 와도 남도록 칸 번호를 저장하고 범위 밖 값은 버린다', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
    const key = selectionStorageKey('draft');
    writeSelection(storage, key, new Set([4, 1]));
    expect([...readSelection(storage, key)]).toEqual([1, 4]);
    data.set(key, JSON.stringify([0, 30, -1, 2.5, 'x']));
    expect([...readSelection(storage, key)]).toEqual([0]);
    writeSelection(storage, key, new Set());
    expect(data.has(key)).toBe(false);
  });
});
