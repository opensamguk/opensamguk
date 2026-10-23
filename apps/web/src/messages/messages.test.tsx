// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem, NationNotice, UnreadResponse } from './contract';
import { clearDrafts } from './drafts';
import { mergeMessages, prependSent, unreadReceivedIds, unreadTotal, visibleScopes } from './merge';

const fake = vi.hoisted(() => ({
  message: {
    list: { query: vi.fn() },
    send: { mutate: vi.fn() },
    markRead: { mutate: vi.fn() },
    unread: { query: vi.fn() },
    recipients: { query: vi.fn() },
  },
  notice: {
    nation: { get: { query: vi.fn() }, set: { mutate: vi.fn() }, markSeen: { mutate: vi.fn() } },
    world: { list: { query: vi.fn() } },
  },
}));

vi.mock('./contract', async (importOriginal) => ({ ...(await importOriginal<object>()), api: fake }));

const { MessagePanel } = await import('./MessagePanel');
const { NationNoticePopup } = await import('./NationNotice');
const { noticeKeys } = await import('./contract');

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

const UNREAD: UnreadResponse = { PRIVATE: 2, NATION: null, DIPLOMACY: null, WORLD: 0 };

let client: QueryClient;
function renderWith(node: ReactNode) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clearDrafts();
  vi.clearAllMocks();
  fake.message.unread.query.mockResolvedValue(UNREAD);
  fake.message.recipients.query.mockResolvedValue({
    generals: [{ id: 7, name: '유비', nation: null }],
    nations: [],
  });
  fake.message.list.query.mockResolvedValue({ items: [], next: null });
  fake.message.markRead.mutate.mockResolvedValue({ updated: 0, unread: UNREAD });
  fake.notice.world.list.query.mockResolvedValue({ items: [] });
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
});

describe('메시지 패널', () => {
  it('볼 수 없는 범위의 탭은 없고 탭 이름에 안 읽음 수가 붙는다', async () => {
    renderWith(<MessagePanel worldId="w1" />);
    // 이 파일의 첫 렌더는 jsdom 준비로 1초를 넘길 수 있다.
    expect(await screen.findByRole('tab', { name: '개인, 안 읽음 2건' }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '전체' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /국가/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /외교/ })).toBeNull();
  });

  it('첫 쪽이 보이면 받은 안 읽은 메시지를 읽음 처리하고 안 읽음 수를 바꾼다', async () => {
    fake.message.list.query.mockResolvedValue({
      items: [item('a', { read: false }), item('b', { read: false }), item('c', { direction: 'sent' })],
      next: null,
    });
    fake.message.markRead.mutate.mockResolvedValue({
      updated: 2,
      unread: { PRIVATE: 0, NATION: null, DIPLOMACY: null, WORLD: 0 },
    });
    renderWith(<MessagePanel worldId="w1" />);
    await waitFor(() => expect(fake.message.markRead.mutate).toHaveBeenCalledTimes(1));
    expect(fake.message.markRead.mutate).toHaveBeenCalledWith({ worldId: 'w1', ids: ['a', 'b'] });
    expect(await screen.findByRole('tab', { name: '개인' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('안 읽음')).toBeNull());
    expect(screen.getByText('더 이전 메시지가 없습니다.')).toBeTruthy();
  });

  it('보내기 실패는 입력을 지우지 않고 서버 문장을 입력칸 설명으로 붙인다', async () => {
    fake.message.send.mutate.mockRejectedValueOnce(
      TRPCClientError.from({
        error: { message: '12초 뒤에 다시 보낼 수 있습니다.', code: -32029, data: { code: 'TOO_MANY_REQUESTS' } },
      }),
    );
    fake.message.send.mutate.mockRejectedValueOnce(TRPCClientError.from(new TypeError('Failed to fetch')));
    renderWith(<MessagePanel worldId="w1" />);
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
    expect(fake.message.send.mutate).toHaveBeenLastCalledWith({
      worldId: 'w1',
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
    fake.message.list.query.mockResolvedValue({ items: [item('a')], next: null });
    fake.message.send.mutate.mockResolvedValue({ item: sent });
    renderWith(<MessagePanel worldId="w1" />);
    await screen.findByText('본문 a');
    await screen.findByRole('option', { name: '유비 (재야)' });
    fireEvent.change(screen.getByRole('combobox', { name: '받는 장수' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('textbox', { name: '메시지 내용' }), { target: { value: '보낸 글' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('보낸 글', { selector: 'p' });
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('');
    fake.message.list.query.mockResolvedValue({ items: [sent, item('a')], next: null });
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(fake.message.list.query).toHaveBeenCalledTimes(2));
    const rows = screen.getAllByRole('listitem').map((row) => row.getAttribute('data-message-id'));
    expect(rows).toEqual(['sent1', 'a']);
  });

  it('패널을 내렸다 다시 올려도 쓰던 글과 고른 탭이 남는다', async () => {
    const first = renderWith(<MessagePanel worldId="w1" />);
    fireEvent.change(await screen.findByRole('textbox', { name: '메시지 내용' }), { target: { value: '쓰던 글' } });
    fireEvent.click(await screen.findByRole('tab', { name: '전체' }));
    first.unmount();
    renderWith(<MessagePanel worldId="w1" />);
    expect((await screen.findByRole('tab', { name: '전체' })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: '개인, 안 읽음 2건' }));
    expect((screen.getByRole('textbox', { name: '메시지 내용' }) as HTMLTextAreaElement).value).toBe('쓰던 글');
  });

  it('전체 탭은 고정 공지를 맨 위에 두고 작성 칸이 없다', async () => {
    fake.notice.world.list.query.mockResolvedValue({
      items: [{ id: 'n1', body: '점검 안내', pinned: true, publishedAt: '2026-10-23T00:00:00Z' }],
    });
    renderWith(<MessagePanel worldId="w1" />);
    fireEvent.click(await screen.findByRole('tab', { name: '전체' }));
    expect(await screen.findByText('점검 안내')).toBeTruthy();
    expect(screen.getByText('고정')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('국가 공지 팝업', () => {
  const notice = (nationId: number, revision: number, body: string, unseen = true): NationNotice => ({
    nationId,
    revision,
    body,
    updatedAt: null,
    updatedBy: null,
    unseen,
    canEdit: false,
  });

  it('닫을 때 띄운 판의 국가와 revision을 보내고, 응답이 아직 unseen이면 그 본문으로 한 번 더 띄운다', async () => {
    fake.notice.nation.get.query.mockResolvedValue(notice(1, 3, 'A 공지'));
    renderWith(<NationNoticePopup worldId="w1" />);
    const dialog = await screen.findByRole('dialog', { name: '국가 공지' });
    expect(dialog.textContent).toContain('A 공지');
    expect(document.activeElement?.textContent).toBe('확인');
    // 팝업을 띄운 사이 재조회로 캐시가 다른 국가의 판으로 바뀐다.
    act(() => client.setQueryData(noticeKeys.nation('w1'), notice(2, 3, 'B 공지')));
    fake.notice.nation.markSeen.mutate.mockResolvedValueOnce(notice(2, 3, 'B 공지'));
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(fake.notice.nation.markSeen.mutate).toHaveBeenCalledWith({ worldId: 'w1', nationId: 1, revision: 3 });
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-nation-id')).toBe('2'));
    expect(screen.getByRole('dialog').textContent).toContain('B 공지');
    fake.notice.nation.markSeen.mutate.mockResolvedValueOnce(notice(2, 3, 'B 공지', false));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(fake.notice.nation.markSeen.mutate).toHaveBeenLastCalledWith({ worldId: 'w1', nationId: 2, revision: 3 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('응답이 null이면(재야가 됨) 다시 띄우지 않고 읽은 공지는 띄우지 않는다', async () => {
    fake.notice.nation.get.query.mockResolvedValue(notice(1, 3, 'A 공지'));
    fake.notice.nation.markSeen.mutate.mockResolvedValue(null);
    renderWith(<NationNoticePopup worldId="w1" />);
    fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(client.getQueryData(noticeKeys.nation('w1'))).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    fake.notice.nation.get.query.mockResolvedValue(notice(1, 4, '읽은 공지', false));
    client = new QueryClient();
    renderWith(<NationNoticePopup worldId="w1" />);
    await waitFor(() => expect(fake.notice.nation.get.query).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
