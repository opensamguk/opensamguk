// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEvent, NotificationResponse } from './contract';

const fake = vi.hoisted(() => ({
  notification: {
    get: { query: vi.fn() },
    setDiscord: { mutate: vi.fn() },
    setEvents: { mutate: vi.fn() },
    removeDiscord: { mutate: vi.fn() },
  },
}));
vi.mock('./contract', async (importOriginal) => ({ ...(await importOriginal<object>()), api: fake }));

const { NotificationSettings, GONE_TEXT } = await import('./NotificationSettingsPage');

// 주소 검사를 통과하는 모양의 가짜 주소다. 실제 디스코드로는 아무것도 보내지 않는다.
const TOKEN = 'fake-token_0123456789abcdefAB12';
const URL = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const OPTIONS: NotificationResponse['eventOptions'] = [
  { key: 'turn.failed', name: '예턴 실패' },
  { key: 'attacked', name: '공격받음' },
  { key: 'diplomacy.offer', name: '외교 제안' },
  { key: 'turns.low', name: '예턴 3칸 이하' },
];
const ALL = OPTIONS.map((o) => o.key);

const response = (
  generation: number,
  events: NotificationEvent[] | null,
  status: 'active' | 'disabled' = 'active',
): NotificationResponse => ({
  discord:
    events === null
      ? null
      : {
          last4: 'AB12',
          status,
          disabledReason: status === 'disabled' ? 'DISCORD_GONE' : null,
          verifiedAt: '2026-10-23T00:00:00Z',
          events,
        },
  generation,
  eventOptions: OPTIONS,
});

const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('알림 설정 등록', () => {
  it('고른 종류로 시험 보내고 저장하고, 주소 칸을 비우며 끝 4자리만 보인다', async () => {
    fake.notification.get.query.mockResolvedValue(response(0, null));
    fake.notification.setDiscord.mutate.mockResolvedValue(response(1, ['turn.failed', 'diplomacy.offer', 'turns.low']));
    renderPage();
    expect(await screen.findByText('등록한 웹훅이 없습니다.', {}, { timeout: 5_000 })).toBeTruthy();
    fireEvent.click(box('공격받음'));
    const input = screen.getByRole('textbox', { name: '웹훅 주소' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: URL } });
    fireEvent.click(screen.getByRole('button', { name: '시험 보내고 저장' }));
    expect(fake.notification.setDiscord.mutate).toHaveBeenCalledWith({
      url: URL,
      events: ['turn.failed', 'diplomacy.offer', 'turns.low'],
      generation: 0,
    });
    expect((await screen.findByTestId('webhook-registered')).textContent).toBe('등록됨 (…AB12)');
    expect((screen.getByRole('textbox', { name: '새 웹훅 주소로 다시 등록' }) as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('실패하면 서버의 고정 문장만 보이고 주소를 화면과 콘솔에 남기지 않는다', async () => {
    const consoleCalls = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    fake.notification.get.query.mockResolvedValue(response(0, null));
    fake.notification.setDiscord.mutate.mockRejectedValue(
      serverError('PRECONDITION_FAILED', '웹훅을 찾을 수 없습니다. 디스코드에서 웹훅 주소를 다시 복사해 주세요.'),
    );
    renderPage();
    const input = (await screen.findByRole('textbox', { name: '웹훅 주소' }, { timeout: 5_000 })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: URL } });
    fireEvent.click(screen.getByRole('button', { name: '시험 보내고 저장' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '웹훅을 찾을 수 없습니다. 디스코드에서 웹훅 주소를 다시 복사해 주세요.',
    );
    expect(input.value).toBe('');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    for (const spy of consoleCalls) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    expect(screen.getByText('등록한 웹훅이 없습니다.')).toBeTruthy();
  });

  it('비활성화된 대상은 안내 한 줄을 보이고 주소를 다시 넣으면 사라진다', async () => {
    fake.notification.get.query.mockResolvedValue(response(3, ALL, 'disabled'));
    fake.notification.setDiscord.mutate.mockResolvedValue(response(4, ALL));
    renderPage();
    expect((await screen.findByRole('alert', {}, { timeout: 5_000 })).textContent).toBe(GONE_TEXT);
    fireEvent.change(screen.getByRole('textbox', { name: '새 웹훅 주소로 다시 등록' }), { target: { value: URL } });
    fireEvent.click(screen.getByRole('button', { name: '시험 보내고 저장' }));
    await waitFor(() => expect(screen.queryByText(GONE_TEXT)).toBeNull());
    expect(fake.notification.setDiscord.mutate).toHaveBeenCalledWith({ url: URL, events: ALL, generation: 3 });
  });

  it('해제는 확인을 거친 뒤 마지막 generation으로 지운다', async () => {
    fake.notification.get.query.mockResolvedValue(response(7, ALL));
    fake.notification.removeDiscord.mutate.mockResolvedValue(response(8, null));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '해제' }, { timeout: 5_000 }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(fake.notification.removeDiscord.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '해제' }));
    expect(await screen.findByText('등록한 웹훅이 없습니다.')).toBeTruthy();
    expect(fake.notification.removeDiscord.mutate).toHaveBeenCalledWith({ generation: 7 });
  });
});

describe('알림 종류 저장', () => {
  it('빠르게 바꿔도 요청을 하나씩 보내고 마지막 상태를 새 generation으로 한 번 더 보낸다', async () => {
    fake.notification.get.query.mockResolvedValue(response(5, ALL));
    const first = deferred<NotificationResponse>();
    const second = deferred<NotificationResponse>();
    fake.notification.setEvents.mutate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '예턴 실패' }, { timeout: 5_000 }));
    fireEvent.click(box('공격받음'));
    expect(fake.notification.setEvents.mutate).toHaveBeenCalledTimes(1);
    expect(fake.notification.setEvents.mutate).toHaveBeenLastCalledWith({
      events: ['attacked', 'diplomacy.offer', 'turns.low'],
      generation: 5,
    });
    expect(box('공격받음').checked).toBe(false);
    expect(box('공격받음').getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByText('저장 중')).toHaveLength(2);
    await act(async () => first.resolve(response(6, ['attacked', 'diplomacy.offer', 'turns.low'])));
    expect(fake.notification.setEvents.mutate).toHaveBeenCalledTimes(2);
    expect(fake.notification.setEvents.mutate).toHaveBeenLastCalledWith({
      events: ['diplomacy.offer', 'turns.low'],
      generation: 6,
    });
    await act(async () => second.resolve(response(7, ['diplomacy.offer', 'turns.low'])));
    expect(screen.queryByText('저장 중')).toBeNull();
    expect(box('예턴 실패').checked).toBe(false);
    expect(box('외교 제안').checked).toBe(true);
    expect(fake.notification.setEvents.mutate).toHaveBeenCalledTimes(2);
  });

  it('실패하면 서버 상태로 되돌리고 이유를 보인다', async () => {
    fake.notification.get.query.mockResolvedValue(response(5, ALL));
    fake.notification.setEvents.mutate.mockRejectedValue(TRPCClientError.from(new TypeError('Failed to fetch')));
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '예턴 실패' }, { timeout: 5_000 }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      '알림 설정을 저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.',
    );
    expect(box('예턴 실패').checked).toBe(true);
  });

  it('CONFLICT면 최신 상태를 다시 받아 그리고 서버 문장을 띄운다', async () => {
    fake.notification.get.query.mockResolvedValueOnce(response(5, ALL)).mockResolvedValueOnce(response(9, null));
    fake.notification.setEvents.mutate.mockRejectedValue(
      serverError('CONFLICT', '다른 곳에서 알림 설정이 바뀌었습니다. 다시 확인해 주세요.'),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: '예턴 실패' }, { timeout: 5_000 }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '다른 곳에서 알림 설정이 바뀌었습니다. 다시 확인해 주세요.',
    );
    expect(await screen.findByText('등록한 웹훅이 없습니다.')).toBeTruthy();
    expect(fake.notification.get.query).toHaveBeenCalledTimes(2);
  });
});
