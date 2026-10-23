// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyLength, type MessageItem, type MessageScope, type NationNotice, type UnreadResponse } from './contract';
import { clearDrafts, readDraft } from './drafts';
import { mergeMessages, prependSent, unreadReceivedIds, unreadTotal, visibleScopes } from './merge';

// 화면은 실제 AppRouter 타입의 tRPC 클라이언트로 부른다. 여기서는 네트워크 대신 마지막 link만 바꿔
// 실제로 나가는 path·input·AbortSignal을 기록하고 path별 처리기의 값을 돌려준다.
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; input: unknown; signal: AbortSignal | null }>,
  handlers: new Map<string, (input: unknown) => unknown>(),
}));

vi.mock('../trpc', async (importOriginal) => {
  const { createTRPCClient, TRPCClientError: ClientError } = await import('@trpc/client');
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        wire.calls.push({ path: op.path, input: op.input, signal: op.signal ?? null });
        const handler = wire.handlers.get(op.path);
        void Promise.resolve()
          .then(() => {
            if (!handler) throw new Error(`처리기가 없습니다: ${op.path}`);
            return handler(op.input);
          })
          .then(
            (data) => {
              observer.next({ result: { data } });
              observer.complete();
            },
            (error: unknown) => observer.error(ClientError.from<AppRouter>(error as Error)),
          );
      });
  return { ...(await importOriginal<object>()), trpcClient: createTRPCClient<AppRouter>({ links: [link] }) };
});

const { TRPCProvider, trpc, trpcClient } = await import('../trpc');
const { useAuthorityWatch } = await import('./authority');
const { MessagePanel } = await import('./MessagePanel');
const { NationNoticeBox, NationNoticePopup } = await import('./NationNotice');

const WORLD = 'w1';
const keys = {
  home: trpc.home.get.queryKey({ worldId: WORLD }),
  unread: trpc.message.unread.queryKey({ worldId: WORLD }),
  notice: trpc.notice.nation.get.queryKey({ worldId: WORLD }),
  recipients: trpc.message.recipients.queryKey({ worldId: WORLD }),
  worldNotices: trpc.notice.world.list.queryKey({ worldId: WORLD }),
  list: (scope: MessageScope) => trpc.message.list.infiniteQueryKey({ worldId: WORLD, scope }),
};

const item = (id: string, extra: Partial<MessageItem> = {}): MessageItem => ({
  id,
  scope: 'PRIVATE',
  direction: 'received',
  from: { generalId: 2, name: '하후돈', nation: { id: 1, name: '위', color: '#000080' } },
  to: { generalId: 1, name: '조조', nation: { id: 1, name: '위', color: '#000080' } },
  body: `본문 ${id}`,
  sentAt: `2026-10-23T10:00:0${id.length}Z`,
  gameDate: { year: 191, month: 1 },
  read: true,
  ...extra,
});

const notice = (nationId: number, revision: number, body: string, unseen = true, canEdit = false): NationNotice => ({
  nationId,
  revision,
  body,
  updatedAt: null,
  updatedBy: null,
  unseen,
  canEdit,
});

const UNREAD: UnreadResponse = { PRIVATE: 2, NATION: null, DIPLOMACY: null, WORLD: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const on = (path: string, handler: (input: unknown) => unknown) => wire.handlers.set(path, handler);
const callsTo = (path: string) => wire.calls.filter((call) => call.path === path);
const rows = () => screen.queryAllByRole('listitem').map((row) => row.getAttribute('data-message-id'));
// 응답을 넘긴 뒤 이어지는 then·setState를 모두 돌린다.
const settle = () => act(async () => {});
const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } });

let client: QueryClient;
let home: { nationId: number | null; officerLevel: number };

// GameLayout에서는 메시지 단추가 권한 감시를 돌린다. 시험은 같은 훅만 따로 붙인다.
function Watch() {
  useAuthorityWatch(WORLD);
  return null;
}

// main.tsx와 같은 계층이다. QueryClientProvider 안에 같은 QueryClient를 쓰는 TRPCProvider를 둔다.
function renderWith(node: ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <Watch />
        {node}
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

// 소속·직책을 바꾸고 home.get을 다시 받게 한다. SSE turn.result·monthly.done·ready가 하는 무효화와 같다.
async function moveTo(nationId: number | null, officerLevel: number) {
  home = { nationId, officerLevel };
  await act(() => client.invalidateQueries({ queryKey: keys.home }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clearDrafts();
  wire.calls.length = 0;
  wire.handlers.clear();
  home = { nationId: 1, officerLevel: 1 };
  on('home.get', () => ({ general: { ...home } }));
  on('message.unread', () => UNREAD);
  on('message.recipients', () => ({ generals: [{ id: 7, name: '유비', nation: null }], nations: [] }));
  on('message.list', () => ({ items: [], next: null }));
  on('message.markRead', () => ({ updated: 0, unread: UNREAD }));
  on('notice.world.list', () => ({ items: [] }));
  on('notice.nation.get', () => null);
});
afterEach(cleanup);

describe('메시지 목록 합치기', () => {
  it('같은 id는 한 줄이고 sentAt, id 내림차순이며 읽음은 한쪽이라도 읽었으면 읽음이다', () => {
    const a = item('a', { sentAt: '2026-10-23T10:00:00Z', read: false });
    const b = item('b', { sentAt: '2026-10-23T10:00:00Z' });
    const c = item('c', { sentAt: '2026-10-23T11:00:00Z' });
    const merged = mergeMessages([[c, a], [{ ...a, read: true }, b], [c]]);
    expect(merged.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(merged.find((m) => m.id === 'a')?.read).toBe(true);
  });

  it('보낸 행을 먼저 넣은 뒤 재조회·다음 쪽이 같은 id를 다시 가져와도 한 줄이다', () => {
    const sent = item('s', { direction: 'sent', sentAt: '2026-10-23T12:00:00Z' });
    const before = { pages: [{ items: [item('a')], next: 'cursor' }], pageParams: [null] };
    const withSent = prependSent(before, sent)!;
    const refetched = [
      [sent, item('a')],
      [item('a'), item('old', { sentAt: '2026-10-22T00:00:00Z' })],
    ];
    const merged = mergeMessages([...withSent.pages.map((p) => p.items), ...refetched]);
    expect(merged.map((m) => m.id)).toEqual(['s', 'a', 'old']);
    expect(prependSent(undefined, sent)).toBeUndefined();
  });

  it('null인 범위는 탭에서 빼고 안 읽음 합계에서도 뺀다', () => {
    expect(visibleScopes(UNREAD)).toEqual(['PRIVATE', 'WORLD']);
    expect(visibleScopes({ PRIVATE: 0, NATION: 1, DIPLOMACY: 2, WORLD: 0 })).toEqual([
      'PRIVATE',
      'NATION',
      'DIPLOMACY',
      'WORLD',
    ]);
    expect(unreadTotal({ PRIVATE: 0, NATION: 1, DIPLOMACY: 2, WORLD: 0 })).toBe(3);
    expect(unreadTotal(undefined)).toBe(0);
    expect(unreadReceivedIds([item('a', { read: false }), item('b', { read: false, direction: 'sent' })])).toEqual([
      'a',
    ]);
  });

  it('본문 길이는 서버처럼 유니코드 코드포인트로 세고 정규화하지 않는다', () => {
    expect('😀'.repeat(1000).length).toBe(2000);
    expect(bodyLength('😀'.repeat(1000))).toBe(1000);
    expect(bodyLength('가'.repeat(1001))).toBe(1001);
    expect(bodyLength('é')).toBe(2);
  });
});

describe('메시지 패널', () => {
  it('볼 수 없는 범위의 탭은 없고 탭 이름에 안 읽음 수가 붙는다', async () => {
    renderWith(<MessagePanel worldId={WORLD} />);
    // 이 파일의 첫 렌더는 jsdom 준비로 1초를 넘길 수 있다.
    expect(await screen.findByRole('tab', { name: '개인, 안 읽음 2건' }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '전체' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /국가/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /외교/ })).toBeNull();
  });

  it('첫 쪽이 보이면 받은 안 읽은 메시지를 읽음 처리하고 안 읽음 수를 바꾼다', async () => {
    on('message.list', () => ({
      items: [item('a', { read: false }), item('b', { read: false }), item('c', { direction: 'sent' })],
      next: null,
    }));
    on('message.markRead', () => ({ updated: 2, unread: { PRIVATE: 0, NATION: null, DIPLOMACY: null, WORLD: 0 } }));
    renderWith(<MessagePanel worldId={WORLD} />);
    await waitFor(() => expect(callsTo('message.markRead')).toHaveLength(1));
    expect(callsTo('message.markRead')[0]!.input).toEqual({ worldId: WORLD, ids: ['a', 'b'] });
    expect(await screen.findByRole('tab', { name: '개인' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('안 읽음')).toBeNull());
    expect(screen.getByText('더 이전 메시지가 없습니다.')).toBeTruthy();
  });

  it('보내기 실패는 입력을 지우지 않고 서버 문장을 입력칸 설명으로 붙인다', async () => {
    let sends = 0;
    on('message.send', () => {
      sends += 1;
      throw sends === 1
        ? TRPCClientError.from({
            error: { message: '12초 뒤에 다시 보낼 수 있습니다.', code: -32029, data: { code: 'TOO_MANY_REQUESTS' } },
          })
        : TRPCClientError.from(new TypeError('Failed to fetch'));
    });
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    const box = screen.getByRole('textbox', { name: '메시지 내용' });
    fireEvent.change(box, { target: { value: '군량을 보내 주시오' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('12초 뒤에 다시 보낼 수 있습니다.');
    expect((box as HTMLTextAreaElement).value).toBe('군량을 보내 주시오');
    expect(screen.getByRole('textbox', { name: '메시지 내용' }).getAttribute('aria-describedby')).toBe(
      screen.getByRole('alert').id,
    );
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('보내지 못했습니다. 연결을 확인하고 다시 보내세요.'),
    );
    expect(callsTo('message.send').at(-1)?.input).toEqual({
      worldId: WORLD,
      scope: 'PRIVATE',
      body: '군량을 보내 주시오',
      toGeneralId: 7,
    });
  });

  it('보내면 응답 행을 맨 위에 넣고 재조회가 같은 id를 가져와도 한 줄이다', async () => {
    const sent = item('sent1', {
      direction: 'sent',
      body: '보낸 글',
      sentAt: '2026-10-23T12:00:00Z',
      to: { generalId: 7, name: '유비', nation: null },
    });
    on('message.list', () => ({ items: [item('a')], next: null }));
    on('message.send', () => ({ item: sent }));
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByText('본문 a');
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('textbox', { name: '메시지 내용' }), { target: { value: '보낸 글' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('보낸 글', { selector: 'p' });
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('');
    const listed = callsTo('message.list').length;
    on('message.list', () => ({ items: [sent, item('a')], next: null }));
    await act(() => client.invalidateQueries({ queryKey: keys.list('PRIVATE') }));
    await waitFor(() => expect(callsTo('message.list')).toHaveLength(listed + 1));
    expect(rows()).toEqual(['sent1', 'a']);
  });

  it('패널을 내렸다 다시 올려도 쓰던 글과 고른 탭이 남는다', async () => {
    const first = renderWith(<MessagePanel worldId={WORLD} />);
    fireEvent.change(await screen.findByRole('textbox', { name: '메시지 내용' }), { target: { value: '쓰던 글' } });
    fireEvent.click(await screen.findByRole('tab', { name: '전체' }));
    first.unmount();
    renderWith(<MessagePanel worldId={WORLD} />);
    expect((await screen.findByRole('tab', { name: '전체' })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await screen.findByRole('tab', { name: '개인, 안 읽음 2건' }));
    // 다시 올린 패널은 권한 값을 새로 정한 뒤에 작성 칸을 그린다.
    const box = (await screen.findByRole('textbox', { name: '메시지 내용' })) as HTMLTextAreaElement;
    expect(box.value).toBe('쓰던 글');
  });

  it('전체 탭은 고정 공지를 맨 위에 두고 작성 칸이 없다', async () => {
    on('notice.world.list', () => ({
      items: [{ id: 'n1', body: '점검 안내', pinned: true, publishedAt: '2026-10-23T00:00:00Z' }],
    }));
    renderWith(<MessagePanel worldId={WORLD} />);
    fireEvent.click(await screen.findByRole('tab', { name: '전체' }));
    expect(await screen.findByText('점검 안내')).toBeTruthy();
    expect(screen.getByText('고정')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('본문이 코드포인트 1,000자를 넘으면 보내지 않고 서버와 같은 이유를 보인다', async () => {
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    const box = screen.getByRole('textbox', { name: '메시지 내용' });
    fireEvent.change(box, { target: { value: '😀'.repeat(1001) } });
    expect(screen.getByText('1001/1000')).toBeTruthy();
    // DisabledReason은 '보내기'와 숨은 ' (사용 불가)'를 이어 이름을 만든다. 환경마다 사이 공백 처리가 달라 그 공백만 허용한다.
    fireEvent.click(screen.getByRole('button', { name: /^보내기\s*\(사용 불가\)$/ }));
    expect(screen.getByRole('note').textContent).toBe('본문은 1,000자까지 쓸 수 있습니다.');
    // UTF-16으로는 2,000이지만 코드포인트 1,000자는 보낼 수 있다.
    fireEvent.change(box, { target: { value: '😀'.repeat(1000) } });
    expect(screen.getByText('1000/1000')).toBeTruthy();
    expect(screen.getByRole('button', { name: '보내기' })).toBeTruthy();
    expect(callsTo('message.send')).toHaveLength(0);
  });
});

describe('메시지 목록 요청', () => {
  it('첫 쪽은 cursor 없이, 다음 쪽은 next를 cursor로 보내고 direction은 보내지 않으며 생성된 키 하나에 쪽을 모은다', async () => {
    on('message.list', (input) =>
      (input as { cursor?: string }).cursor === 'c1'
        ? { items: [item('a'), item('old', { sentAt: '2026-10-22T00:00:00Z' })], next: null }
        : { items: [item('a'), item('b')], next: 'c1' },
    );
    renderWith(<MessagePanel worldId={WORLD} />);
    fireEvent.click(await screen.findByRole('button', { name: '이전 메시지 더 보기' }));
    await screen.findByText('본문 old');
    const inputs = callsTo('message.list').map((call) => call.input);
    expect(inputs).toEqual([
      { worldId: WORLD, scope: 'PRIVATE' },
      { worldId: WORLD, scope: 'PRIVATE', cursor: 'c1' },
    ]);
    for (const input of inputs) expect(input).not.toHaveProperty('direction');
    expect(rows()).toEqual(['b', 'a', 'old']);
    const cached = client.getQueryData(keys.list('PRIVATE'));
    expect(cached?.pages).toHaveLength(2);
    expect(cached?.pageParams).toEqual([null, 'c1']);
    const exact = [['message', 'list'], { input: { worldId: WORLD, scope: 'PRIVATE' }, type: 'infinite' }];
    expect(client.getQueryCache().find({ queryKey: exact, exact: true })).toBeTruthy();
  });

  it('목록 조회를 취소하면 AbortSignal이 실제 요청까지 닿고 늦게 온 응답은 캐시에 들어가지 않는다', async () => {
    const pending = deferred<unknown>();
    on('message.list', () => pending.promise);
    renderWith(<MessagePanel worldId={WORLD} />);
    await waitFor(() => expect(callsTo('message.list')).toHaveLength(1));
    const signal = callsTo('message.list')[0]!.signal;
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(false);
    await act(() => client.cancelQueries({ queryKey: keys.list('PRIVATE') }));
    expect(signal!.aborted).toBe(true);
    await act(async () => pending.resolve({ items: [item('late')], next: null }));
    await settle();
    expect(client.getQueryData(keys.list('PRIVATE'))).toBeUndefined();
    expect(screen.queryByText('본문 late')).toBeNull();
    expect(callsTo('message.list')).toHaveLength(1);
  });
});

describe('권한 변경', () => {
  it('소속·직책이 바뀌면 새 응답 전에는 예전 권한의 탭과 공지 칸을 보이지 않는다', async () => {
    home = { nationId: 1, officerLevel: 12 };
    on('message.unread', () => ({ PRIVATE: 0, NATION: 0, DIPLOMACY: 0, WORLD: 0 }));
    on('notice.nation.get', () => notice(1, 3, 'A 공지', false, true));
    renderWith(
      <>
        <MessagePanel worldId={WORLD} />
        <NationNoticeBox worldId={WORLD} />
      </>,
    );
    expect(await screen.findByRole('tab', { name: '외교' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '고치기' })).toBeTruthy();
    const unread = deferred<UnreadResponse>();
    const fresh = deferred<NationNotice | null>();
    on('message.unread', () => unread.promise);
    on('notice.nation.get', () => fresh.promise);
    await moveTo(2, 1);
    await waitFor(() => expect(screen.queryByRole('tab', { name: '외교' })).toBeNull());
    expect(screen.queryByRole('tab', { name: '국가' })).toBeNull();
    expect(screen.queryByTestId('nation-notice')).toBeNull();
    await act(async () => {
      unread.resolve({ PRIVATE: 0, NATION: 0, DIPLOMACY: null, WORLD: 0 });
      fresh.resolve(notice(2, 1, 'B 공지', false, false));
    });
    expect(await screen.findByRole('tab', { name: '국가' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '외교' })).toBeNull();
    expect((await screen.findByTestId('nation-notice')).textContent).toContain('B 공지');
    expect(screen.queryByRole('button', { name: '고치기' })).toBeNull();
  });

  it('첫 권한 값을 받기 전에는 남아 있던 캐시를 그리지 않고 받은 뒤 서버에 다시 묻는다', async () => {
    client.setQueryData(keys.unread, { PRIVATE: 0, NATION: 0, DIPLOMACY: 5, WORLD: 0 });
    client.setQueryData(keys.notice, notice(9, 1, '다른 세션 공지', false, true));
    const first = deferred<unknown>();
    on('home.get', () => first.promise);
    on('message.unread', () => ({ PRIVATE: 0, NATION: null, DIPLOMACY: null, WORLD: 0 }));
    renderWith(
      <>
        <MessagePanel worldId={WORLD} />
        <NationNoticeBox worldId={WORLD} />
      </>,
    );
    expect(await screen.findByRole('tab', { name: '개인' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /외교/ })).toBeNull();
    expect(screen.queryByTestId('nation-notice')).toBeNull();
    expect(callsTo('message.unread')).toHaveLength(0);
    await act(async () => first.resolve({ general: { nationId: null, officerLevel: 0 } }));
    await waitFor(() =>
      expect(client.getQueryData(keys.unread)).toEqual({ PRIVATE: 0, NATION: null, DIPLOMACY: null, WORLD: 0 }),
    );
    expect(callsTo('message.unread')).toHaveLength(1);
    await waitFor(() => expect(client.getQueryData(keys.notice)).toBeNull());
    expect(screen.queryByRole('tab', { name: /외교/ })).toBeNull();
    expect(screen.queryByTestId('nation-notice')).toBeNull();
  });

  it('첫 권한 값 전에는 남은 개인 목록·받는 사람·월드 공지 캐시를 그리지 않고 읽음 처리도 보내지 않는다', async () => {
    client.setQueryData(keys.list('PRIVATE'), {
      pages: [{ items: [item('x', { read: false, body: '남의 본문' })], next: null }],
      pageParams: [null],
    });
    client.setQueryData(keys.recipients, { generals: [{ id: 99, name: '남의 장수', nation: null }], nations: [] });
    client.setQueryData(keys.worldNotices, {
      items: [{ id: 'n9', body: '남의 공지', pinned: true, publishedAt: '2026-10-23T00:00:00Z' }],
    });
    const first = deferred<unknown>();
    on('home.get', () => first.promise);
    renderWith(<MessagePanel worldId={WORLD} />);
    expect(await screen.findByRole('tab', { name: '개인' })).toBeTruthy();
    expect(screen.queryByText('남의 본문')).toBeNull();
    expect(screen.queryByRole('option', { name: '남의 장수 (재야)' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '전체' }));
    expect(screen.queryByText('남의 공지')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '개인' }));
    await settle();
    expect(callsTo('message.markRead')).toHaveLength(0);
    expect(callsTo('message.list')).toHaveLength(0);
    await act(async () => first.resolve({ general: { nationId: 1, officerLevel: 1 } }));
    expect(await screen.findByText('메시지가 없습니다')).toBeTruthy();
    expect(await screen.findByRole('option', { name: '유비 (재야)' })).toBeTruthy();
    expect(screen.queryByText('남의 본문')).toBeNull();
    expect(screen.queryByRole('option', { name: '남의 장수 (재야)' })).toBeNull();
    expect(callsTo('message.markRead')).toHaveLength(0);
  });

  it('권한이 바뀐 뒤 도착한 예전 국가의 send 성공 응답은 새 목록에 넣지 않는다', async () => {
    on('message.unread', () => ({ PRIVATE: 0, NATION: 0, DIPLOMACY: null, WORLD: 0 }));
    renderWith(<MessagePanel worldId={WORLD} />);
    fireEvent.click(await screen.findByRole('tab', { name: '국가' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '메시지 내용' }), {
      target: { value: '옛 국가에 보냄' },
    });
    const late = deferred<unknown>();
    on('message.send', () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(callsTo('message.send')).toHaveLength(1));
    expect(callsTo('message.send')[0]!.input).toEqual({ worldId: WORLD, scope: 'NATION', body: '옛 국가에 보냄' });
    await moveTo(2, 1);
    // 새 국가의 국가 목록을 서버에서 다시 받은 뒤에 늦은 응답을 넘긴다. 막지 않으면 이 첫 쪽에 들어간다.
    await waitFor(() => expect(screen.getByRole('tab', { name: '국가' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(client.getQueryData(keys.list('NATION'))?.pages).toHaveLength(1));
    await act(async () =>
      late.resolve({ item: item('late', { scope: 'NATION', direction: 'sent', body: '옛 국가에 보냄' }) }),
    );
    await settle();
    expect(screen.queryByText('옛 국가에 보냄', { selector: 'p' })).toBeNull();
    const ids = client.getQueryData(keys.list('NATION'))?.pages.flatMap((page) => page.items.map((m) => m.id)) ?? [];
    expect(ids).not.toContain('late');
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('');
    expect(readDraft('messages:compose:w1:NATION:1', null)).toMatchObject({ body: '' });
  });

  it('권한이 바뀐 뒤 도착한 send 실패는 같은 작성 칸에 띄우지 않고 쓰던 글을 남긴다', async () => {
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('textbox', { name: '메시지 내용' }), { target: { value: '늦게 실패할 글' } });
    const late = deferred<unknown>();
    on('message.send', () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(callsTo('message.send')).toHaveLength(1));
    await moveTo(2, 1);
    await act(async () => late.reject(serverError('FORBIDDEN', '이 범위의 메시지를 읽을 수 없습니다.')));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('늦게 실패할 글');
  });

  it('권한이 바뀐 뒤 도착한 markRead 응답은 새 안 읽음 수를 덮지 않는다', async () => {
    on('message.list', () => ({ items: [item('a', { read: false })], next: null }));
    on('message.unread', () => ({ PRIVATE: 1, NATION: 0, DIPLOMACY: null, WORLD: 0 }));
    const late = deferred<unknown>();
    let marks = 0;
    on('message.markRead', () => (marks++ === 0 ? late.promise : new Promise(() => {})));
    renderWith(<MessagePanel worldId={WORLD} />);
    await waitFor(() => expect(callsTo('message.markRead')).toHaveLength(1));
    on('message.unread', () => ({ PRIVATE: 3, NATION: 0, DIPLOMACY: null, WORLD: 0 }));
    await moveTo(2, 1);
    expect(await screen.findByRole('tab', { name: '개인, 안 읽음 3건' })).toBeTruthy();
    await act(async () => late.resolve({ updated: 1, unread: { PRIVATE: 0, NATION: 0, DIPLOMACY: null, WORLD: 0 } }));
    await settle();
    expect(client.getQueryData(keys.unread)).toMatchObject({ PRIVATE: 3 });
    expect(screen.getByRole('tab', { name: '개인, 안 읽음 3건' })).toBeTruthy();
  });

  it('권한이 바뀐 뒤 도착한 공지 저장 응답은 새 국가의 공지 칸을 덮지 않는다', async () => {
    home = { nationId: 1, officerLevel: 12 };
    on('notice.nation.get', () => notice(1, 3, 'A 공지', false, true));
    renderWith(<NationNoticeBox worldId={WORLD} />);
    fireEvent.click(await screen.findByRole('button', { name: '고치기' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A 새 공지' } });
    const late = deferred<unknown>();
    on('notice.nation.set', () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(callsTo('notice.nation.set')).toHaveLength(1));
    on('notice.nation.get', () => notice(2, 5, 'B 공지', false, false));
    await moveTo(2, 1);
    await waitFor(() => expect(screen.getByTestId('nation-notice').textContent).toContain('B 공지'));
    await act(async () => late.resolve(notice(1, 4, 'A 새 공지', true, true)));
    await settle();
    const box = screen.getByTestId('nation-notice');
    expect(box.textContent).toContain('B 공지');
    expect(box.textContent).not.toContain('A 새 공지');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(client.getQueryData(keys.notice)).toMatchObject({ nationId: 2, revision: 5 });
  });

  it('home 재조회가 UNAUTHORIZED로 끝나면 권한을 거두고 늦은 query·send 응답이 화면을 다시 채우지 않는다', async () => {
    home = { nationId: 1, officerLevel: 12 };
    on('message.unread', () => ({ PRIVATE: 0, NATION: 0, DIPLOMACY: 0, WORLD: 0 }));
    on('message.list', () => ({ items: [item('a')], next: null }));
    on('notice.nation.get', () => notice(1, 3, 'A 공지', true, true));
    renderWith(
      <>
        <MessagePanel worldId={WORLD} />
        <NationNoticeBox worldId={WORLD} />
        <NationNoticePopup worldId={WORLD} />
      </>,
    );
    await screen.findByText('본문 a');
    expect(await screen.findByRole('dialog', { name: '국가 공지' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '외교' })).toBeTruthy();
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('textbox', { name: '메시지 내용' }), { target: { value: '늦게 갈 글' } });
    const lateSend = deferred<unknown>();
    on('message.send', () => lateSend.promise);
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(callsTo('message.send')).toHaveLength(1));
    const lateList = deferred<unknown>();
    const listed = callsTo('message.list').length;
    on('message.list', () => lateList.promise);
    act(() => {
      void client.invalidateQueries({ queryKey: keys.list('PRIVATE') });
    });
    await waitFor(() => expect(callsTo('message.list')).toHaveLength(listed + 1));

    on('home.get', () => {
      throw serverError('UNAUTHORIZED', '로그인이 필요합니다.');
    });
    await act(() => client.invalidateQueries({ queryKey: keys.home }));
    await waitFor(() => expect(screen.queryByText('본문 a')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('nation-notice')).toBeNull();
    expect(screen.queryByRole('tab', { name: /외교/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '메시지 내용' })).toBeNull();

    await act(async () => {
      lateList.resolve({ items: [item('late-list')], next: null });
      lateSend.resolve({ item: item('late-send', { direction: 'sent' }) });
    });
    await settle();
    expect(screen.queryByText('본문 late-list')).toBeNull();
    expect(screen.queryByText('본문 late-send')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.getQueryData(keys.list('PRIVATE'))).toBeUndefined();
    expect(client.getQueryData(keys.unread)).toBeUndefined();
    expect(client.getQueryData(keys.notice)).toBeUndefined();
  });

  it('성공·거절·연결 실패·새 성공이 같은 밀리초여도 거절 뒤에는 새로 성공한 home만 믿는다', async () => {
    // TanStack의 dataUpdatedAt·errorUpdatedAt이 모두 같은 값이 되게 시각을 고정한다. 타이머는 실제 시간 그대로다.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      on('message.unread', () => ({ PRIVATE: 0, NATION: 0, DIPLOMACY: null, WORLD: 0 }));
      renderWith(<MessagePanel worldId={WORLD} />);
      expect(await screen.findByRole('tab', { name: '국가' })).toBeTruthy();

      on('home.get', () => {
        throw serverError('UNAUTHORIZED', '로그인이 필요합니다.');
      });
      await act(() => client.invalidateQueries({ queryKey: keys.home }));
      await waitFor(() => expect(screen.queryByRole('tab', { name: '국가' })).toBeNull());

      // 거절 뒤 연결 실패가 오류를 덮어써도 남아 있는 예전 home 값으로 돌아가지 않는다.
      on('home.get', () => {
        throw TRPCClientError.from(new TypeError('Failed to fetch'));
      });
      await act(() => client.invalidateQueries({ queryKey: keys.home }));
      expect(client.getQueryState(keys.home)?.status).toBe('error');
      expect(client.getQueryData(keys.home)).toMatchObject({ general: { nationId: 1 } });
      await settle();
      expect(screen.queryByRole('tab', { name: '국가' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: '메시지 내용' })).toBeNull();

      // 서버가 다시 성공하면 같은 밀리초라도 그 값을 믿고 메시지·공지를 서버에 다시 묻는다.
      const asked = callsTo('message.unread').length;
      on('home.get', () => ({ general: { ...home } }));
      await act(() => client.invalidateQueries({ queryKey: keys.home }));
      expect(client.getQueryState(keys.home)?.dataUpdatedAt).toBe(client.getQueryState(keys.home)?.errorUpdatedAt);
      expect(await screen.findByRole('tab', { name: '국가' })).toBeTruthy();
      expect(callsTo('message.unread').length).toBeGreaterThan(asked);
    } finally {
      now.mockRestore();
    }
  });

  it('캐시 비우기로 home query가 사라지면 바로 권한을 거두고 그 뒤 끝난 send 응답이 본문과 캐시를 되살리지 않는다', async () => {
    on('message.list', () => ({ items: [item('a')], next: null }));
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByText('본문 a');
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    const box = screen.getByRole('textbox', { name: '메시지 내용' });
    fireEvent.change(box, { target: { value: '로그아웃 전에 보낸 글' } });

    // 다른 query를 지우는 것은 권한과 무관하다. 작성 칸과 쓰던 글이 그대로다.
    act(() => client.removeQueries({ queryKey: keys.unread }));
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe(
      '로그아웃 전에 보낸 글',
    );

    const late = deferred<unknown>();
    on('message.send', () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(callsTo('message.send')).toHaveLength(1));

    // LogoutButton·AuthForm처럼 캐시를 비운다. 이 사이 누가 home을 다시 물으면 서버는 거절한다.
    on('home.get', () => {
      throw serverError('UNAUTHORIZED', '로그인이 필요합니다.');
    });
    act(() => client.clear());
    // clear는 query를 지울 뿐이고 남은 관찰자가 home을 다시 만들거나 묻는 것은 보장하지 않는다. Watch는 마운트된 그대로다.
    expect(client.getQueryCache().find({ queryKey: keys.home, exact: true })).toBeUndefined();
    expect(screen.queryByRole('textbox', { name: '메시지 내용' })).toBeNull();
    expect(screen.queryByText('본문 a')).toBeNull();

    await act(async () =>
      late.resolve({ item: item('late-send', { direction: 'sent', body: '로그아웃 전에 보낸 글' }) }),
    );
    await settle();
    expect(screen.queryByText('로그아웃 전에 보낸 글', { selector: 'p' })).toBeNull();
    expect(screen.queryByText('본문 a')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '메시지 내용' })).toBeNull();
    expect(client.getQueryData(keys.list('PRIVATE'))).toBeUndefined();
    expect(client.getQueryData(keys.unread)).toBeUndefined();

    // 새로 만든 home query가 서버에서 성공해야만 다시 믿는다. 예전 send 응답은 그 뒤에도 목록에 없다.
    on('home.get', () => ({ general: { ...home } }));
    await act(() =>
      client.fetchQuery({ queryKey: keys.home, queryFn: () => trpcClient.home.get.query({ worldId: WORLD }) }),
    );
    expect(await screen.findByText('본문 a')).toBeTruthy();
    expect(await screen.findByRole('textbox', { name: '메시지 내용' })).toBeTruthy();
    expect(screen.queryByText('로그아웃 전에 보낸 글', { selector: 'p' })).toBeNull();
    const ids = client.getQueryData(keys.list('PRIVATE'))?.pages.flatMap((page) => page.items.map((m) => m.id)) ?? [];
    expect(ids).toEqual(['a']);
  });

  it('home 재조회가 연결 실패로 끝나면 권한을 거두지 않고 목록과 쓰던 글을 그대로 둔다', async () => {
    on('message.unread', () => ({ PRIVATE: 0, NATION: 0, DIPLOMACY: null, WORLD: 0 }));
    on('message.list', () => ({ items: [item('a')], next: null }));
    renderWith(<MessagePanel worldId={WORLD} />);
    await screen.findByText('본문 a');
    fireEvent.change(screen.getByRole('textbox', { name: '메시지 내용' }), { target: { value: '끊겨도 남을 글' } });
    on('home.get', () => {
      throw TRPCClientError.from(new TypeError('Failed to fetch'));
    });
    // 연결 실패는 retryUnlessClientError로 한 번 더 묻는다. invalidateQueries는 그 재시도까지 기다린다.
    await act(() => client.invalidateQueries({ queryKey: keys.home }));
    expect(client.getQueryState(keys.home)?.status).toBe('error');
    expect(screen.getByText('본문 a')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '국가' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('끊겨도 남을 글');
    expect(callsTo('message.unread')).toHaveLength(1);
  });
});

describe('국가 공지 팝업', () => {
  it('닫을 때 띄운 판의 국가와 revision을 보내고, 응답이 아직 unseen이면 그 본문으로 한 번 더 띄운다', async () => {
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    renderWith(<NationNoticePopup worldId={WORLD} />);
    const dialog = await screen.findByRole('dialog', { name: '국가 공지' });
    expect(dialog.textContent).toContain('A 공지');
    expect(document.activeElement?.textContent).toBe('확인');
    // 팝업을 띄운 사이 재조회로 캐시가 다른 국가의 판으로 바뀐다.
    act(() => client.setQueryData(keys.notice, notice(2, 3, 'B 공지')));
    on('notice.nation.markSeen', () => notice(2, 3, 'B 공지'));
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(callsTo('notice.nation.markSeen')).toHaveLength(1));
    expect(callsTo('notice.nation.markSeen')[0]!.input).toEqual({ worldId: WORLD, nationId: 1, revision: 3 });
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('2'));
    expect(screen.getByRole('dialog').textContent).toContain('B 공지');
    on('notice.nation.markSeen', () => notice(2, 3, 'B 공지', false));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(callsTo('notice.nation.markSeen')).toHaveLength(2));
    expect(callsTo('notice.nation.markSeen')[1]!.input).toEqual({ worldId: WORLD, nationId: 2, revision: 3 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('응답이 null이면(재야가 됨) 다시 띄우지 않고 읽은 공지는 띄우지 않는다', async () => {
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    on('notice.nation.markSeen', () => null);
    renderWith(<NationNoticePopup worldId={WORLD} />);
    fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(client.getQueryData(keys.notice)).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    on('notice.nation.get', () => notice(1, 4, '읽은 공지', false));
    const asked = callsTo('notice.nation.get').length;
    client = new QueryClient();
    renderWith(<NationNoticePopup worldId={WORLD} />);
    await waitFor(() => expect(callsTo('notice.nation.get')).toHaveLength(asked + 1));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('닫는 사이 권한이 바뀌면 그 markSeen 응답으로 띄우지 않고 새로 받은 공지로 정한다', async () => {
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    renderWith(<NationNoticePopup worldId={WORLD} />);
    await screen.findByRole('dialog', { name: '국가 공지' });
    const late = deferred<unknown>();
    on('notice.nation.markSeen', () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(callsTo('notice.nation.markSeen')).toHaveLength(1));
    expect(callsTo('notice.nation.markSeen')[0]!.input).toEqual({ worldId: WORLD, nationId: 1, revision: 3 });
    on('notice.nation.get', () => notice(2, 3, 'B 공지'));
    await moveTo(2, 1);
    // 새 home은 이미 캐시에 있다. 화면이 B 공지를 그리기를 기다리지 않고 바로 늦은 markSeen 응답을 넘긴다.
    expect(client.getQueryData(keys.home)).toMatchObject({ general: { nationId: 2 } });
    await act(async () => late.resolve(notice(1, 4, '옛 응답')));
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('2'));
    expect(screen.getByRole('dialog').textContent).toContain('B 공지');
    expect(screen.queryByText('옛 응답')).toBeNull();
    expect(client.getQueryData(keys.notice)).toMatchObject({ nationId: 2 });
  });

  it('A 팝업을 띄운 채 B로 옮겨도 닫을 때 A 판을 보내고 그 뒤 B 응답을 따른다', async () => {
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    renderWith(<NationNoticePopup worldId={WORLD} />);
    await screen.findByRole('dialog', { name: '국가 공지' });
    on('notice.nation.get', () => notice(2, 3, 'B 공지'));
    await moveTo(2, 1);
    await waitFor(() => expect(client.getQueryData(keys.notice)).toMatchObject({ nationId: 2 }));
    expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('1');
    expect(screen.getByRole('dialog').textContent).toContain('A 공지');
    on('notice.nation.markSeen', () => notice(2, 3, 'B 공지'));
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(callsTo('notice.nation.markSeen')).toHaveLength(1));
    expect(callsTo('notice.nation.markSeen')[0]!.input).toEqual({ worldId: WORLD, nationId: 1, revision: 3 });
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('2'));
    expect(screen.getByRole('dialog').textContent).toContain('B 공지');
  });

  it('A에서 B로 옮겨 두 팝업을 닫은 뒤 A로 돌아와 서버가 A를 unseen으로 주면 다시 띄운다', async () => {
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    renderWith(<NationNoticePopup worldId={WORLD} />);
    await screen.findByRole('dialog', { name: '국가 공지' });
    on('notice.nation.get', () => notice(2, 3, 'B 공지'));
    await moveTo(2, 1);
    await waitFor(() => expect(client.getQueryData(keys.notice)).toMatchObject({ nationId: 2 }));
    // 다른 국가로 옮긴 장수의 A 닫기는 서버가 A를 읽음으로 두지 않고 B를 돌려준다.
    on('notice.nation.markSeen', () => notice(2, 3, 'B 공지'));
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('2'));
    on('notice.nation.markSeen', () => notice(2, 3, 'B 공지', false));
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(callsTo('notice.nation.markSeen')).toHaveLength(2));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    on('notice.nation.get', () => notice(1, 3, 'A 공지'));
    await moveTo(1, 1);
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('1'));
    expect(screen.getByRole('dialog').getAttribute('data-revision')).toBe('3');
    expect(screen.getByRole('dialog').textContent).toContain('A 공지');
  });
});
