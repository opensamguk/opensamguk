// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPicker } from '../turns/CommandPicker';
import { readSelection, selectionStorageKey, writeSelection } from '../turns/useTurnDraft';
import { buildClauses, describeClause, emptyCompose, type ComposeState } from './clauses';
import type { ActionInput, Allowed, TreatyRow } from './contract';
import { busyText, parseDiplomacySearch, treatiesForTab } from './DiplomacyPage';
import {
  applyCheckError,
  applyOutcome,
  applySendError,
  finishedText,
  readTracked,
  requestsStorageKey,
  startRequest,
  writeTracked,
  type RequestsState,
} from './requests';
import { tradeChoices } from './tradeTargets';
import { TreatyCard } from './TreatyCard';

afterEach(cleanup);

// 계약 모양(docs/plans/T2-07.md API 계약)으로 만든 시험용 조약.
const nation = (id: number, name: string) => ({ id, name, color: '#336699' });
const ok: Allowed = { ok: true };
const treaty = (patch: Partial<TreatyRow> = {}): TreatyRow => ({
  id: 't1',
  from: nation(2, '원소'),
  to: nation(1, '조조'),
  incoming: true,
  clauses: [
    { kind: 'nonAggression', months: 24, enforced: true },
    { kind: 'note', text: '서로 사신을 보낸다', enforced: false },
  ],
  status: 'PROPOSED',
  proposedSeq: 10,
  proposedAt: { year: 191, month: 3 },
  respondBy: { year: 191, month: 9 },
  startAt: null,
  endAt: null,
  monthsLeft: null,
  brokenBy: null,
  cost: { mine: 1200, theirs: 1200 },
  counterpartTrust: { nation: nation(2, '원소'), brokenTreaties: 2, lastBrokenAt: { year: 190, month: 5 } },
  canAccept: ok,
  canReject: ok,
  canBreak: null,
  ...patch,
});
const names = { nation: (id: number) => (id === 1 ? '조조' : '원소'), city: (key: number) => `도시${key}` };

describe('조약서 조항', () => {
  const form = (patch: Partial<ComposeState>): ComposeState => ({ ...emptyCompose(), toNationId: 2, ...patch });

  it('고른 조항만 화면 순서대로 만들고 내는 쪽·넘기는 쪽을 국가 ID로 바꾼다', () => {
    const built = buildClauses(
      form({
        nonAggression: { on: true, months: '24' },
        tribute: { on: true, payer: 'them', gold: '500', rice: '0', months: '12' },
        cityTransfer: { on: true, giver: 'us', cityKey: 7 },
        note: { on: true, text: ' 사신을 보낸다 ' },
      }),
      1,
      'NONE',
    );
    expect(built.problems).toEqual([]);
    expect(built.clauses).toEqual([
      { kind: 'nonAggression', months: 24 },
      { kind: 'tribute', payerNationId: 2, gold: 500, rice: 0, months: 12 },
      { kind: 'cityTransfer', cityKey: 7, giverNationId: 1 },
      { kind: 'note', text: '사신을 보낸다' },
    ]);
  });

  it('종전은 교전·선포 상대에게만 넣는다', () => {
    expect(buildClauses(form({ peace: true }), 1, 'WAR').clauses).toEqual([{ kind: 'peace' }]);
    expect(buildClauses(form({ peace: true }), 1, 'DECLARED').problems).toEqual([]);
    const none = buildClauses(form({ peace: true }), 1, 'NON_AGGRESSION');
    expect(none.clauses).toEqual([]);
    expect(none.problems[0]).toContain('종전');
  });

  it('범위 밖 기간, 빈 원조, 빈 도시, 상대 없음, 조항 없음은 보내기 전에 막는다', () => {
    expect(buildClauses(form({ nonAggression: { on: true, months: '121' } }), 1, 'NONE').problems).toEqual([
      '불가침 기간은 1~120개월입니다.',
    ]);
    expect(
      buildClauses(form({ tribute: { on: true, payer: 'us', gold: '0', rice: '0', months: '3' } }), 1, 'NONE').problems,
    ).toEqual(['정기 원조는 금이나 쌀 중 하나는 넣으세요.']);
    expect(buildClauses(form({ passage: { on: true, cityKeys: [] } }), 1, 'NONE').problems).toEqual([
      '통행을 허용할 우리 도시를 고르세요.',
    ]);
    expect(buildClauses({ ...emptyCompose(), trade: { on: true, months: '6' } }, 1, undefined).problems).toEqual([
      '상대 국가를 고르세요.',
    ]);
    expect(buildClauses(form({}), 1, 'NONE').problems).toEqual(['조항을 하나 이상 고르세요.']);
    expect(buildClauses(form({ note: { on: true, text: 'x'.repeat(301) } }), 1, 'NONE').problems).toEqual([
      '약속 문장은 300자까지입니다.',
    ]);
  });

  it('조항 요약은 서버가 준 도시 이름을 먼저 쓴다', () => {
    expect(describeClause({ kind: 'passage', cityKeys: [3, 4], cityNames: ['업', '복양'] }, names)).toBe(
      '통행 허용 (업, 복양)',
    );
    expect(describeClause({ kind: 'passage', cityKeys: [3] }, names)).toBe('통행 허용 (도시3)');
    expect(describeClause({ kind: 'tribute', payerNationId: 2, gold: 1500, rice: 0, months: 12 }, names)).toBe(
      '정기 원조 (원소 부담, 매월 금 1,500 쌀 0, 12개월)',
    );
    expect(describeClause({ kind: 'cityTransfer', cityKey: 9, giverNationId: 1 }, names)).toBe(
      '도시 이양 (도시9, 넘기는 쪽 조조)',
    );
  });
});

describe('즉시 행동 요청 추적', () => {
  const propose: ActionInput = {
    kind: 'propose',
    input: { toNationId: 2, clauses: [{ kind: 'trade', months: 6 }], expiresInMonths: 6 },
  };
  const accept: ActionInput = { kind: 'respond', input: { treatyId: 't1', accept: true } };
  const empty: RequestsState = { tracked: [], finished: [] };
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
  };

  it('키에 계정과 월드를 넣고, 되살린 요청은 결과를 묻는 상태로 시작한다', () => {
    expect(requestsStorageKey('u1', 'w1')).not.toBe(requestsStorageKey('u2', 'w1'));
    const storage = memory();
    const state = startRequest(empty, 'r1', propose);
    writeTracked(storage, 'k', state.tracked);
    expect(readTracked(storage, 'k')).toEqual([{ requestId: 'r1', action: propose, phase: 'checking' }]);
    writeTracked(storage, 'k', []);
    expect(storage.getItem('k')).toBeNull();
  });

  it('깨진 저장값과 모양이 다른 요청은 버린다', () => {
    const storage = memory();
    storage.setItem('k', '{깨진');
    expect(readTracked(storage, 'k')).toEqual([]);
    storage.setItem(
      'k',
      JSON.stringify([
        { requestId: 'a', action: { kind: 'respond', input: { treatyId: 't1' } } },
        { requestId: '', action: accept },
        { requestId: 'b', action: accept },
      ]),
    );
    expect(readTracked(storage, 'k').map((t) => t.requestId)).toEqual(['b']);
  });

  it('pending은 처리 중으로 두고 applied·rejected에서만 결과를 확정한다', () => {
    let state = startRequest(empty, 'r1', accept);
    state = applyOutcome(state, { status: 'pending', requestId: 'r1' });
    expect(state.tracked[0]?.phase).toBe('pending');
    expect(state.finished).toEqual([]);
    state = applyOutcome(state, { status: 'applied', requestId: 'r1', treaty: null });
    expect(state.tracked).toEqual([]);
    expect(state.finished[0]).toMatchObject({ requestId: 'r1', result: 'applied', treaty: null });
    expect(finishedText(state.finished[0]!)).toBe('조약을 맺었습니다.');

    const rejected = applyOutcome(startRequest(empty, 'r2', accept), {
      status: 'rejected',
      requestId: 'r2',
      code: 'INSUFFICIENT_GOLD',
      reason: '국고가 모자랍니다.',
    });
    expect(finishedText(rejected.finished[0]!)).toBe('수락 요청이 거절되었습니다. 국고가 모자랍니다.');
  });

  it('응답을 못 받으면 다시 보낼 수 있게, 로그인이 풀리면 requestId를 남기고, 서버 거절은 확정한다', () => {
    const start = startRequest(empty, 'r1', propose);
    expect(applySendError(start, 'r1', undefined, undefined).tracked[0]?.phase).toBe('unknown');
    const auth = applySendError(start, 'r1', 'UNAUTHORIZED', '로그인하세요');
    expect(auth.tracked).toEqual([{ requestId: 'r1', action: propose, phase: 'auth' }]);
    const conflict = applySendError(start, 'r1', 'CONFLICT', '요청을 처리하는 중입니다');
    expect(conflict.tracked).toEqual([]);
    expect(finishedText(conflict.finished[0]!)).toBe('제안 요청이 거절되었습니다. 요청을 처리하는 중입니다');
  });

  it('결과 조회에서 NOT_FOUND는 다시 보내기, 연결 실패는 그대로 다시 묻기', () => {
    const checking: RequestsState = { tracked: [{ requestId: 'r1', action: accept, phase: 'checking' }], finished: [] };
    expect(applyCheckError(checking, 'r1', 'NOT_FOUND').tracked[0]?.phase).toBe('unknown');
    expect(applyCheckError(checking, 'r1', 'UNAUTHORIZED').tracked[0]?.phase).toBe('auth');
    expect(applyCheckError(checking, 'r1', undefined)).toBe(checking);
  });

  it('카드 처리 중 안내는 내 요청이 먼저, 없으면 같은 국가 다른 장수의 대기 요청', () => {
    const tracked = startRequest(empty, 'r1', accept).tracked;
    expect(busyText('t1', tracked, [])).toBe('수락 보내는 중');
    const other = [
      {
        requestId: 'x',
        kind: 'break' as const,
        treatyId: 't2',
        toNation: null,
        accept: null,
        requestedBy: { generalId: 5, name: '순욱' },
      },
    ];
    expect(busyText('t2', tracked, other)).toBe('순욱의 요청을 처리하는 중입니다.');
    expect(busyText('t3', tracked, other)).toBeNull();
  });
});

describe('외교실 탭', () => {
  it('상태별로 나누고 모르는 탭은 받은 제안으로 둔다', () => {
    const items = [
      treaty({ id: 'a' }),
      treaty({ id: 'b', incoming: false }),
      treaty({ id: 'c', status: 'ACTIVE' }),
      treaty({ id: 'd', status: 'EXPIRED' }),
      treaty({ id: 'e', status: 'REJECTED' }),
      treaty({ id: 'f', status: 'BROKEN' }),
    ];
    expect(treatiesForTab(items, 'incoming').map((t) => t.id)).toEqual(['a']);
    expect(treatiesForTab(items, 'outgoing').map((t) => t.id)).toEqual(['b']);
    expect(treatiesForTab(items, 'active').map((t) => t.id)).toEqual(['c']);
    expect(treatiesForTab(items, 'ended').map((t) => t.id)).toEqual(['d', 'e']);
    expect(treatiesForTab(items, 'broken').map((t) => t.id)).toEqual(['f']);
    expect(parseDiplomacySearch({ tab: 'nope' })).toEqual({ tab: 'incoming' });
    expect(parseDiplomacySearch({ tab: 'trust' })).toEqual({ tab: 'trust' });
  });
});

describe('조약 카드', () => {
  it('받은 제안은 조항을 집행·기록으로 나누고 비용과 상대 신의를 보인다', () => {
    render(<TreatyCard treaty={treaty()} names={names} busy={null} onRespond={vi.fn()} onBreak={vi.fn()} />);
    expect(screen.getByRole('region', { name: '서버가 집행하는 조항' }).textContent).toContain('불가침 24개월');
    expect(screen.getByRole('region', { name: '기록만 남는 조항' }).textContent).toContain('서로 사신을 보낸다');
    expect(screen.getByText('우리 금 1,200 · 상대 금 1,200')).toBeTruthy();
    expect(screen.getByText('파기 2회 (마지막 190년 5월)')).toBeTruthy();
  });

  it('국고가 모자라면 수락만 이유와 함께 잠기고 거절은 그대로 누른다', () => {
    const onRespond = vi.fn();
    render(
      <TreatyCard
        treaty={treaty({ canAccept: { ok: false, code: 'INSUFFICIENT_GOLD', reason: '금 1,200이 필요합니다.' } })}
        names={names}
        busy={null}
        onRespond={onRespond}
        onBreak={vi.fn()}
      />,
    );
    const acceptButton = screen.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ });
    fireEvent.click(acceptButton);
    expect(screen.getByRole('note').textContent).toBe('금 1,200이 필요합니다.');
    fireEvent.click(screen.getByRole('button', { name: '거절' }));
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('권한이 없으면 쓰기 단추를 그리지 않고 읽기만 한다고 알린다', () => {
    const denied: Allowed = { ok: false, code: 'NO_PERMISSION', reason: '군주와 참모만 답합니다.' };
    render(
      <TreatyCard
        treaty={treaty({ canAccept: denied, canReject: denied })}
        names={names}
        busy={null}
        onRespond={vi.fn()}
        onBreak={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /수락|거절/ })).toBeNull();
    expect(screen.getByText(/읽기만 합니다/)).toBeTruthy();
  });

  it('처리 중이면 단추를 잠그고 그 안내를 보인다', () => {
    const onRespond = vi.fn();
    render(<TreatyCard treaty={treaty()} names={names} busy="수락 처리 중" onRespond={onRespond} onBreak={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('수락 처리 중');
    fireEvent.click(screen.getByRole('button', { name: /^수락\s*\(사용 불가\)$/ }));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('파기는 신의 기록 확인을 거쳐야 보낸다', () => {
    const onBreak = vi.fn();
    render(
      <TreatyCard
        treaty={treaty({ status: 'ACTIVE', incoming: false, canAccept: null, canReject: null, canBreak: ok })}
        names={names}
        busy={null}
        onRespond={vi.fn()}
        onBreak={onBreak}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '파기' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('신의 기록에 남습니다');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onBreak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '파기' }));
    fireEvent.click(screen.getByRole('button', { name: '파기 확정' }));
    expect(onBreak).toHaveBeenCalledOnce();
  });
});

describe('예턴 편집의 교역 대상', () => {
  const target = {
    cityKey: 12,
    cityName: '복양',
    nation: nation(2, '원소'),
    treatyId: 't1',
    tradeEndsAt: { year: 192, month: 1 },
  };

  it('교역 조약이 있는 도시만 후보로 두고 없으면 서버가 준 이유를 보인다', () => {
    expect(tradeChoices({ fromCityKey: 3, items: [target], blocked: null }, false)).toEqual({
      options: [{ key: 12, name: '복양 (원소, 192년 1월까지)' }],
      note: null,
    });
    expect(tradeChoices({ fromCityKey: 3, items: [], blocked: '교역 조약이 없습니다.' }, false)).toEqual({
      options: [],
      note: '교역 조약이 없습니다.',
    });
    expect(tradeChoices(undefined, true).note).toBe('교역할 수 있는 도시를 불러오지 못했습니다.');
  });

  it('교역 명령을 고르면 대상 도시 칸이 교역 후보만 보이고 지도 선택이 후보 밖이면 기본값으로 쓰지 않는다', () => {
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
        cityChoicesFor={(key) =>
          key === 'trade' ? tradeChoices({ fromCityKey: 3, items: [target], blocked: null }, false) : null
        }
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '교역' }));
    const select = screen.getByRole('combobox', { name: /대상 도시/ }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['고르세요', '복양 (원소, 192년 1월까지)']);
    expect(select.value).toBe('');
    expect(screen.queryByRole('button', { name: /지도에서 고른 도시/ })).toBeNull();
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
