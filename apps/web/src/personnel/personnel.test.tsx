// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSaveSlots, toTurn } from '../turns/draft';
import type { Trpc } from '../trpc';
import { readStored } from '../turns/useTurnDraft';
import type {
  AssignmentOfferView,
  NationTurnTab,
  PersonnelApi,
  PersonnelBoard,
  PersonnelRecord,
  RequestState,
} from './contract';
import { NATION_SLOT_COUNT, nationDraftKey, nationSource } from './NationTurnsPage';
import { OfferCard } from './OfferBox';
import { PersonnelBoardView } from './PersonnelPage';
import { euro, iGa, markAnnounced, noticeFor, readAnnounced, recover, sendAction } from './request';

afterEach(cleanup);

// 서버가 답한 오류. 응답을 못 받은 연결 오류는 TRPCClientError.from(new Error())처럼 data가 없다.
const serverError = (code: string, message: string) =>
  new TRPCClientError(message, { result: { error: { message, code: -32000, data: { code } } } });
const networkError = () => new TRPCClientError('fetch failed');

const fakeApi = (overrides: Partial<PersonnelApi>): PersonnelApi =>
  ({
    officers: vi.fn(),
    act: vi.fn(),
    request: vi.fn(),
    recent: vi.fn(),
    offers: vi.fn(),
    nationTurns: vi.fn(),
    setNationTurns: vi.fn(),
    nationCommands: vi.fn(),
    precheckNation: vi.fn(),
    ...overrides,
  }) as PersonnelApi;

describe('즉시 행동 보내기', () => {
  const accept = { kind: 'offer.respond', offerId: '10-1-2', accept: true } as const;

  it('첫 요청이 연결 오류면 같은 requestId로 한 번 더 보낸다', async () => {
    const applied: RequestState<never> = { status: 'pending', requestId: 'r-1' };
    const act = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(applied);
    const outcome = await sendAction(fakeApi({ act }), 'w', 'r-1', accept);
    expect(outcome).toEqual({ type: 'state', state: applied });
    expect(act).toHaveBeenCalledTimes(2);
    expect(act.mock.calls.map(([input]) => (input as { requestId: string }).requestId)).toEqual(['r-1', 'r-1']);
    expect(act.mock.calls[0]![0]).toEqual({ worldId: 'w', requestId: 'r-1', action: accept });
  });

  it('서버가 답한 거부는 다시 보내지 않고 그 문구를 돌려준다', async () => {
    const act = vi.fn().mockRejectedValue(serverError('CONFLICT', '요청을 처리하는 중입니다'));
    const outcome = await sendAction(fakeApi({ act }), 'w', 'r-2', accept);
    expect(outcome).toEqual({ type: 'error', code: 'CONFLICT', message: '요청을 처리하는 중입니다' });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('두 번 다 답을 못 받으면 접수 여부를 확인하러 간다', async () => {
    const act = vi.fn().mockRejectedValue(networkError());
    expect(await sendAction(fakeApi({ act }), 'w', 'r-3', accept)).toEqual({ type: 'lost' });
    expect(act).toHaveBeenCalledTimes(2);
  });
});

describe('다시 접속했을 때 되살리기', () => {
  const record = (
    requestId: string,
    kind: PersonnelRecord['kind'],
    status: 'pending' | 'applied',
  ): PersonnelRecord => ({
    kind,
    state:
      status === 'pending'
        ? { status, requestId }
        : {
            status,
            requestId,
            result: { offerStatus: 'ACCEPTED', city: { cityKey: 3, name: '북평' }, dedicationLost: 0 },
          },
  });

  it('대기 중인 접수와 아직 안내하지 않은 끝난 접수를 이 화면 종류만 고른다', () => {
    // personnel.recent는 최신 순이다.
    const records = [
      record('new', 'offer.respond', 'pending'),
      record('appoint', 'personnel.appoint', 'applied'),
      record('mid', 'offer.respond', 'applied'),
      record('seen', 'offer.respond', 'applied'),
      record('old', 'offer.respond', 'applied'),
    ];
    const { pending, unannounced } = recover(records, ['offer.respond'], ['seen']);
    expect(pending?.state.requestId).toBe('new');
    expect(unannounced.map((r) => r.state.requestId)).toEqual(['old', 'mid']);
  });

  it('안내한 requestId는 계정·월드 키에 남고 저장소를 못 쓰면 빈 목록이다', () => {
    const storage = window.localStorage;
    storage.clear();
    markAnnounced(storage, 'k', 'a');
    markAnnounced(storage, 'k', 'b');
    markAnnounced(storage, 'k', 'a');
    expect(readAnnounced(storage, 'k')).toEqual(['b', 'a']);
    const broken = {
      getItem: () => {
        throw new Error('막힘');
      },
      setItem: () => {
        throw new Error('막힘');
      },
    } as unknown as Storage;
    expect(readAnnounced(broken, 'k')).toEqual([]);
    expect(() => markAnnounced(broken, 'k', 'c')).not.toThrow();
  });
});

describe('결과 안내 문구', () => {
  it('조사는 받침에 맞춘다', () => {
    expect(iGa('공손찬')).toBe('공손찬이');
    expect(iGa('조조')).toBe('조조가');
    expect(euro('북평')).toBe('북평으로');
    expect(euro('업')).toBe('업으로');
    expect(euro('낙양')).toBe('낙양으로');
    expect(euro('서주')).toBe('서주로');
    expect(euro('하비')).toBe('하비로');
    expect(euro('장수')).toBe('장수로');
    expect(euro('남皮')).toBe('남皮(으)로');
  });

  it('requestId 결과로만 만들고 대기 중이면 안내하지 않는다', () => {
    const nameOf = (id: number) => (id === 7 ? '관우' : undefined);
    expect(noticeFor('offer.respond', { status: 'pending', requestId: 'r' }, nameOf)).toBeNull();
    expect(
      noticeFor(
        'offer.respond',
        {
          status: 'applied',
          requestId: 'r',
          result: { offerStatus: 'REJECTED', city: { cityKey: 1, name: '업' }, dedicationLost: 120 },
        },
        nameOf,
      ),
    ).toEqual({ tone: 'ok', text: '발령을 거절했습니다. 공헌이 120 줄었습니다.' });
    expect(
      noticeFor(
        'offer.respond',
        {
          status: 'applied',
          requestId: 'r',
          result: { offerStatus: 'ACCEPTED', city: { cityKey: 3, name: '북평' }, dedicationLost: 0 },
        },
        nameOf,
      )?.text,
    ).toBe('발령을 수락해 북평으로 옮겼습니다.');
    expect(
      noticeFor(
        'personnel.appoint',
        { status: 'applied', requestId: 'r', result: { generalId: 7, officerLevel: 11, title: '참모' } },
        nameOf,
      )?.text,
    ).toBe('관우의 직책을 참모로 바꿨습니다.');
    expect(
      noticeFor(
        'personnel.dismiss',
        { status: 'rejected', requestId: 'r', code: 'FORBIDDEN', message: '군주만 임명할 수 있습니다' },
        nameOf,
      ),
    ).toEqual({ tone: 'error', text: '군주만 임명할 수 있습니다' });
  });
});

describe('국가 칸 저장', () => {
  const tab: NationTurnTab = {
    office: { nationId: 4, officerLevel: 11, tenure: 3 },
    officerLevel: 11,
    title: '참모',
    holder: { generalId: 7, name: '관우' },
    edit: { ok: true },
    revision: 9,
    slots: Array.from({ length: NATION_SLOT_COUNT }, (_, i) =>
      i === 0
        ? { commandKey: 'nation_assign', args: { generalId: 2, cityKey: 5 }, name: '발령' }
        : { commandKey: 'rest', args: {}, name: '휴식' },
    ),
  };
  const context = { trpc: {} as Trpc, userId: 'u1', worldId: 'w1' };

  it('저장 입력에 표시 이름이 없고 읽은 office와 revision을 그대로 보낸다', async () => {
    const setNationTurns = vi.fn().mockResolvedValue({ ok: true, revision: 10, slots: tab.slots });
    const source = nationSource(fakeApi({ setNationTurns }), tab, { onOfficeChanged: vi.fn() })(context);
    const list = source.list.select({ tabs: [tab] });
    expect(list.revision).toBe(9);
    await source.save({ revision: list.revision, slots: toSaveSlots(list.slots.map(toTurn)) });
    const input = setNationTurns.mock.calls[0]![0] as { office: unknown; revision: number; slots: unknown[] };
    expect(input.office).toEqual({ nationId: 4, officerLevel: 11, tenure: 3 });
    expect(input.revision).toBe(9);
    expect(input.slots).toHaveLength(12);
    expect(input.slots[0]).toEqual({ commandKey: 'nation_assign', args: { generalId: 2, cityKey: 5 } });
    expect(input.slots.slice(1).every((slot) => slot === null)).toBe(true);
    expect(JSON.stringify(input.slots)).not.toContain('name');
  });

  it('저장 결과는 그 직책 탭의 revision과 칸만 바꾸고 직책 정보와 다른 탭은 그대로 둔다', () => {
    const queryClient = new QueryClient();
    const lord: NationTurnTab = {
      ...tab,
      office: { nationId: 4, officerLevel: 12, tenure: 1 },
      officerLevel: 12,
      title: '군주',
      holder: { generalId: 1, name: '유비' },
      edit: { ok: false, reason: '내 직책 칸이 아닙니다' },
    };
    const source = nationSource(fakeApi({}), tab, { onOfficeChanged: vi.fn() })(context);
    queryClient.setQueryData(source.list.queryKey, { tabs: [lord, tab] });
    const slots = tab.slots.map((slot, i) =>
      i === 1 ? { commandKey: 'nation_reward', args: { generalId: 2, amount: 100 }, name: '포상' } : slot,
    );
    source.writeList(queryClient, { revision: 10, slots });
    expect(queryClient.getQueryData(source.list.queryKey)).toEqual({ tabs: [lord, { ...tab, revision: 10, slots }] });
    expect(source.list.select(queryClient.getQueryData(source.list.queryKey))).toEqual({ revision: 10, slots });
  });

  it('남의 칸은 서버가 준 이유로 읽기 전용이고 내 칸만 실행 시기를 센다', () => {
    const other = { ...tab, edit: { ok: false as const, reason: '내 직책 칸이 아닙니다' } };
    const source = nationSource(fakeApi({}), other, { onOfficeChanged: vi.fn() })(context);
    expect(source.readOnly).toBe('내 직책 칸이 아닙니다');
    expect(source.timed).toBe(false);
    expect(nationSource(fakeApi({}), tab, { onOfficeChanged: vi.fn() })(context).readOnly).toBeNull();
  });

  it('초안 키는 계정·월드와 본 직책(tenure 포함)마다 다르다', () => {
    const key = nationDraftKey('u1', 'w1', tab.office);
    expect(key).not.toBe(nationDraftKey('u1', 'w1', { ...tab.office, tenure: 4 }));
    expect(key).not.toBe(nationDraftKey('u1', 'w1', { ...tab.office, officerLevel: 10 }));
    expect(key).not.toBe(nationDraftKey('u2', 'w1', tab.office));
    expect(nationSource(fakeApi({}), tab, { onOfficeChanged: vi.fn() })(context).storageKey).toBe(key);
  });

  it('12칸 초안만 읽는다', () => {
    const storage = window.sessionStorage;
    const draft = (n: number) => ({
      draft: { baseRevision: 1, ops: [], turns: Array.from({ length: n }, () => ({ commandKey: 'rest', args: {} })) },
      pending: null,
    });
    storage.setItem('a', JSON.stringify(draft(12)));
    storage.setItem('b', JSON.stringify(draft(30)));
    expect(readStored(storage, 'a', 12).draft?.turns).toHaveLength(12);
    expect(readStored(storage, 'b', 12).draft).toBeNull();
    expect(readStored(storage, 'b').draft?.turns).toHaveLength(30);
  });

  it('국가 사전 검사의 거부 이유를 편집기 경고 문구로 바꾼다', () => {
    const source = nationSource(fakeApi({}), tab, { onOfficeChanged: vi.fn() })(context);
    const check = source.precheck({ commandKey: 'nation_reward', args: {}, explicit: true });
    expect(check.select({ ok: false, reason: '국고가 모자랍니다' })).toEqual({
      ok: false,
      message: '국고가 모자랍니다',
    });
    expect(check.select({ ok: true })).toEqual({ ok: true });
  });
});

describe('발령 제안 상자', () => {
  const offer: AssignmentOfferView = {
    id: '10-1-2',
    issuer: { generalId: 1, name: '공손찬' },
    targetCity: { cityKey: 3, name: '북평' },
    expires: { year: 191, month: 3, monthsLeft: 1 },
    rejectCost: { dedicationPercent: 10, dedication: 45 },
    respond: { ok: true },
  };

  it('보낸 사람·도시·남은 기한과 거절 비용을 보이고 누르면 한 번 알린다', () => {
    const onRespond = vi.fn();
    render(<OfferCard offer={offer} busy={false} onRespond={onRespond} />);
    expect(screen.getByText('공손찬이 북평으로 발령했습니다 · 남은 기한 1개월, 넘기면 수락')).toBeTruthy();
    expect(screen.getByText(/거절하면 공헌이 10% 줄어듭니다/).textContent).toContain('45');
    fireEvent.click(screen.getByRole('button', { name: '거절' }));
    expect(onRespond.mock.calls).toEqual([[false]]);
  });

  it('처리 중이면 두 버튼을 막고 다시 눌러도 알리지 않는다', () => {
    const onRespond = vi.fn();
    render(<OfferCard offer={offer} busy onRespond={onRespond} />);
    expect(screen.getByRole('status').textContent).toBe('처리 중');
    fireEvent.click(screen.getByRole('button', { name: /수락/ }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toBe('요청을 처리하는 중입니다.');
  });

  it('접수 전에도 두 버튼은 막고 상태와 막힌 이유를 보내는 중으로 보인다', () => {
    const onRespond = vi.fn();
    render(<OfferCard offer={offer} busy busyLabel="보내는 중" onRespond={onRespond} />);
    expect(screen.getByRole('status').textContent).toBe('보내는 중');
    fireEvent.click(screen.getByRole('button', { name: /수락/ }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toBe('요청을 보내는 중입니다.');
  });

  it('응답할 수 없으면 서버가 준 이유를 펼친다', () => {
    render(
      <OfferCard
        offer={{ ...offer, respond: { ok: false, reason: '응답을 처리하는 중입니다' } }}
        busy={false}
        onRespond={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /거절/ }));
    expect(screen.getByRole('note').textContent).toBe('응답을 처리하는 중입니다');
  });
});

describe('인사부', () => {
  const board: PersonnelBoard = {
    appoint: { ok: true },
    levels: [
      { officerLevel: 11, title: '참모', holderId: 2 },
      { officerLevel: 10, title: '수뇌', holderId: null },
    ],
    members: [
      {
        generalId: 1,
        name: '유비',
        officerLevel: 12,
        title: '군주',
        isHuman: true,
        city: { cityKey: 1, name: '신야' },
        dedication: 900,
      },
      {
        generalId: 2,
        name: '제갈량',
        officerLevel: 11,
        title: '참모',
        isHuman: false,
        city: { cityKey: 1, name: '신야' },
        dedication: 500,
      },
      {
        generalId: 3,
        name: '조운',
        officerLevel: 1,
        title: '장수',
        isHuman: true,
        city: { cityKey: 2, name: '양양' },
        dedication: 300,
      },
    ],
  };

  it('군주는 빈 자리에 직책 없는 장수만 고르고 앉은 자리는 해임한다', () => {
    const onAppoint = vi.fn();
    const onDismiss = vi.fn();
    render(<PersonnelBoardView board={board} busyTarget={null} onAppoint={onAppoint} onDismiss={onDismiss} />);
    const select = screen.getByLabelText('수뇌 임명할 장수');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['고르세요', '조운']);
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '임명' }));
    fireEvent.click(screen.getByRole('button', { name: '해임' }));
    expect(onAppoint.mock.calls).toEqual([[3, 10]]);
    expect(onDismiss.mock.calls).toEqual([[2, 11]]);
    expect(screen.getAllByText('사람')).toHaveLength(2);
    expect(screen.getByText('NPC')).toBeTruthy();
  });

  it('군주가 아니면 입력을 열지 않고 서버가 준 이유를 보인다', () => {
    const onAppoint = vi.fn();
    render(
      <PersonnelBoardView
        board={{ ...board, appoint: { ok: false, reason: '군주만 임명할 수 있습니다' } }}
        busyTarget={null}
        onAppoint={onAppoint}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /임명/ }));
    expect(screen.getByRole('note').textContent).toBe('군주만 임명할 수 있습니다');
    expect(onAppoint).not.toHaveBeenCalled();
  });

  it('처리 중이면 모든 직책 버튼을 막고 그 직책에만 처리 중을 보인다', () => {
    render(<PersonnelBoardView board={board} busyTarget="level-10" onAppoint={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('status').map((s) => s.closest('tr')?.getAttribute('data-level'))).toEqual(['10']);
  });

  it('인사 접수 전에는 모든 직책을 막고 보낸 직책에만 보내는 중을 보인다', () => {
    const onAppoint = vi.fn();
    const onDismiss = vi.fn();
    render(
      <PersonnelBoardView
        board={board}
        busyTarget="level-10"
        busyLabel="보내는 중"
        onAppoint={onAppoint}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('보내는 중');
    fireEvent.click(screen.getByRole('button', { name: /임명/ }));
    expect(onAppoint).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toBe('요청을 보내는 중입니다.');
  });
});
