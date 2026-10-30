// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminCreateActions } from './AdminCreateActions';
import { options, requestId, requestKey, viewerId, worldId } from './test/createFixture';
import type { CreateInput } from './adminCreateModel';

const state = vi.hoisted(() => ({
  me: vi.fn(),
  whoami: vi.fn(),
  settings: vi.fn(),
  create: vi.fn(),
  status: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: state.invalidate }), useBlocker: vi.fn() }));
vi.mock('../trpc', () => ({
  useTRPCClient: () => ({
    auth: { me: { query: state.me } },
    admin: {
      whoami: { query: state.whoami },
      world: {
        creationOptions: { query: state.settings },
        create: { mutate: state.create },
        createStatus: { query: state.status },
      },
    },
  }),
}));
const failure = (code: string) =>
  new TRPCClientError(code, { result: { error: { code: -32000, message: code, data: { code } } } });
const pending = (key: string) => ({
  userId: viewerId,
  requestId,
  idempotencyKey: key,
  status: 'PENDING',
  worldId: null,
  error: null,
});
function setup() {
  return render(
    <AdminCreateActions
      viewerId={viewerId}
      disabled={false}
      onAcquire={() => true}
      onRelease={vi.fn()}
      onClear={vi.fn()}
    />,
  );
}
async function review() {
  fireEvent.click(screen.getByRole('button', { name: '새 월드 생성 준비' }));
  await screen.findByLabelText('월드 이름');
  fireEvent.change(screen.getByLabelText('월드 이름'), { target: { value: '화면 생성' } });
  fireEvent.change(screen.getByLabelText('프리셋'), { target: { value: 'regular' } });
  fireEvent.click(screen.getByRole('button', { name: '현재 설정 검토' }));
  await screen.findByRole('dialog');
}
async function submit() {
  fireEvent.click(screen.getByRole('checkbox', { name: '이름·현재 설정·시드와 개장 전 생성을 확인했습니다.' }));
  fireEvent.click(screen.getByRole('button', { name: '개장 전 월드 생성 요청' }));
  await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('계정·생성 설정과 요청을 확인하고 있습니다.')).toBeNull());
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  state.me.mockResolvedValue({ user: { id: viewerId } });
  state.whoami.mockResolvedValue({ admin: true });
  state.settings.mockResolvedValue(structuredClone(options));
  state.create.mockImplementation(async (input: CreateInput) => pending(input.idempotencyKey));
  state.status.mockImplementation(async (input: { idempotencyKey: string }) => pending(input.idempotencyKey));
});
afterEach(cleanup);
describe('AC-M3-04 원생성 화면과 실제 요청 전 경계', () => {
  it('폼의 조건부 입력·선택과 확인 체크 상자의 접근 이름은 화면 라벨과 같다', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '새 월드 생성 준비' }));
    await screen.findByLabelText('월드 이름');
    const labels = ['시나리오', '프리셋', '자동 종료', '시드 선택'];
    const exactLabels = () => {
      for (const label of labels) {
        const control = screen.getByRole('combobox', { name: label }) as HTMLSelectElement;
        // 정확 label 검색은 감싼 label의 option 문구까지 읽으므로 role 검색만으로는 놓친다.
        const names = control.getAttribute('aria-label')
          ? [control.getAttribute('aria-label')]
          : Array.from(control.labels ?? [], (element) => element.textContent?.replace(/\s+/g, ' ').trim());
        expect(names).toContain(label);
      }
    };
    const exactInput = (role: 'textbox' | 'spinbutton', label: string) => {
      const control = screen.getByRole(role, { name: label });
      expect(control).toBe(screen.getByLabelText(label, { exact: true }));
      return control;
    };
    expect(screen.getAllByRole('combobox')).toHaveLength(labels.length);
    for (const label of labels)
      expect(screen.getByRole('combobox', { name: label })).toBe(screen.getByLabelText(label, { exact: true }));
    exactLabels();
    fireEvent.change(screen.getByRole('combobox', { name: '프리셋' }), { target: { value: 'regular' } });
    for (const endMode of ['year', 'none']) {
      fireEvent.change(screen.getByRole('combobox', { name: '자동 종료' }), { target: { value: endMode } });
      for (const seedMode of ['auto', 'custom']) {
        fireEvent.change(screen.getByRole('combobox', { name: '시드 선택' }), { target: { value: seedMode } });
        exactLabels();
        const controls = labels.map((label) => screen.getByRole('combobox', { name: label }));
        controls.push(exactInput('textbox', '월드 이름'), exactInput('spinbutton', '턴 간격 (분)'));
        if (endMode === 'year') controls.push(exactInput('spinbutton', '종료 연도'));
        else expect(screen.queryByRole('spinbutton', { name: '종료 연도' })).toBeNull();
        if (seedMode === 'custom') {
          const seed = exactInput('textbox', '시드');
          controls.push(seed);
          const description = document.getElementById(seed.getAttribute('aria-describedby')!);
          expect(description?.textContent).toBe('재현할 게임의 시드입니다. 비밀번호나 인증 키를 입력하지 마세요.');
        } else expect(screen.queryByRole('textbox', { name: '시드' })).toBeNull();
        expect(new Set(document.querySelectorAll('form input, form select'))).toEqual(new Set(controls));
      }
    }
    fireEvent.change(exactInput('textbox', '월드 이름'), { target: { value: '접근 이름 확인' } });
    fireEvent.change(exactInput('textbox', '시드'), { target: { value: 'label-regression' } });
    fireEvent.click(screen.getByRole('button', { name: '현재 설정 검토' }));
    await screen.findByRole('dialog');
    const consent = '이름·현재 설정·시드와 개장 전 생성을 확인했습니다.';
    expect(screen.getByRole('checkbox', { name: consent })).toBe(screen.getByLabelText(consent, { exact: true }));
    expect(state.create).not.toHaveBeenCalled();
  });
  it('검토만으로 생성하지 않고 최종 두 번 클릭도 한 요청만 보낸다', async () => {
    setup();
    await review();
    expect(state.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: '개장 전 월드 생성 요청' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    await screen.findByText('접수됨 · 생성 대기');
    const input = state.create.mock.calls[0]![0] as CreateInput;
    expect(input.expectedUserId).toBe(viewerId);
    expect(input.ruleFeatures).toContain('city-resources-v1');
    const stored = sessionStorage.getItem(`opensamguk:admin-create:v1:${viewerId}`)!;
    expect(stored).toContain(input.idempotencyKey);
    expect(stored).not.toContain(input.seed!);
    expect(stored).not.toContain('화면 생성');
  });
  it('확인 중 metadata가 바뀌면 POST0으로 다시 확인한다', async () => {
    setup();
    await review();
    state.settings.mockResolvedValue({ ...options, revision: 'changed' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '개장 전 월드 생성 요청' }));
    await screen.findByText('생성 설정이 바뀌었습니다. 현재 내용을 다시 확인하세요.');
    expect(state.create).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('응답 유실 뒤 수동 재접수는 같은 객체·키·시드이며 focus에 자동POST가 없다', async () => {
    setup();
    await review();
    state.create.mockRejectedValueOnce(new TRPCClientError('network'));
    await submit();
    const first = state.create.mock.calls[0]![0];
    fireEvent.click(screen.getByRole('button', { name: '같은 요청 접수 확인' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
    expect(state.create.mock.calls[1]![0]).toBe(first);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(state.create).toHaveBeenCalledTimes(2);
  });
  it('현재 계정이 바뀌면 생성0과 권한 재확인이고 다른 계정의 결과를 쓰지 않는다', async () => {
    setup();
    await review();
    state.me.mockResolvedValue({ user: { id: worldId } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '개장 전 월드 생성 요청' }));
    await waitFor(() => expect(state.invalidate).toHaveBeenCalled());
    expect(state.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('NOT_FOUND 상태조회와 CONFLICT 재접수 모두 새 요청을 열지 않는다', async () => {
    setup();
    await review();
    state.create.mockRejectedValue(failure('CONFLICT'));
    await submit();
    state.status.mockRejectedValue(failure('NOT_FOUND'));
    fireEvent.click(screen.getByRole('button', { name: '요청 상태 확인' }));
    await waitFor(() => expect(state.status).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: '생성 준비 닫기' })).toBeNull();
    expect(state.create).toHaveBeenCalledTimes(1);
  });
  it('reload 포인터는 본인 상태만 수동 조회하고 완료 문구와 UUID를 구분한다', async () => {
    sessionStorage.setItem(
      `opensamguk:admin-create:v1:${viewerId}`,
      JSON.stringify({ version: 1, viewerId, idempotencyKey: requestKey }),
    );
    setup();
    fireEvent.click(screen.getByRole('button', { name: '새 월드 생성 준비' }));
    await screen.findByRole('button', { name: '요청 상태 확인' });
    expect(state.status).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '같은 요청 접수 확인' })).toBeNull();
    state.status.mockResolvedValue({ ...pending(requestKey), status: 'DONE', worldId });
    fireEvent.click(screen.getByRole('button', { name: '요청 상태 확인' }));
    await waitFor(() =>
      expect(state.status).toHaveBeenCalledWith(
        { expectedUserId: viewerId, idempotencyKey: requestKey },
        expect.anything(),
      ),
    );
    const completed = await screen.findByText('생성 완료 · 개장 전', { exact: true });
    const uuid = screen.getByText(worldId, { exact: true });
    expect(completed.textContent).toBe('생성 완료 · 개장 전');
    expect(completed.contains(uuid)).toBe(false);
    expect(screen.getByRole('status').contains(completed)).toBe(true);
    expect(screen.getByRole('status').contains(uuid)).toBe(true);
    expect(screen.queryByLabelText('월드 이름')).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`opensamguk:admin-create:v1:${viewerId}`)).toBeNull();
  });
  it('깨진 보관 정보는 폼과 생성0으로 막는다', async () => {
    sessionStorage.setItem(`opensamguk:admin-create:v1:${viewerId}`, 'broken');
    setup();
    fireEvent.click(screen.getByRole('button', { name: '새 월드 생성 준비' }));
    await screen.findByText('보관한 요청 정보를 읽지 못했습니다. 관리자 기록에서 접수 여부를 먼저 확인하세요.');
    expect(screen.queryByLabelText('월드 이름')).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });
  it('도시 규칙 미등록은 고정 사유와 생성0으로 표시한다', async () => {
    state.settings.mockResolvedValue({
      ...options,
      profiles: [
        {
          id: 'integration-v01',
          label: '통합판',
          available: false,
          code: 'RULES_UNAVAILABLE',
          reason: '도시 규칙 준비 중',
        },
      ],
    });
    setup();
    fireEvent.click(screen.getByRole('button', { name: '새 월드 생성 준비' }));
    await screen.findByText('도시 규칙 준비 중');
    expect(screen.queryByLabelText('월드 이름')).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });
  it('늦은 생성 응답은 계정 세대가 바뀐 화면에 완료로 표시하지 않는다', async () => {
    let finish!: (value: unknown) => void;
    state.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setup();
    await review();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '개장 전 월드 생성 요청' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    const input = state.create.mock.calls[0]![0] as CreateInput;
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      finish({ ...pending(input.idempotencyKey), status: 'DONE', worldId });
    });
    expect(screen.queryByText('생성 완료 · 개장 전')).toBeNull();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`opensamguk:admin-create:v1:${viewerId}`)).toContain(input.idempotencyKey);
  });
  it('429 재접수는 기한 전 비활성이며 시간 경과에 자동으로 쓰지 않는다', async () => {
    setup();
    await review();
    state.create.mockRejectedValue(
      new TRPCClientError('limited', {
        result: { error: { code: -32000, message: 'limited', data: { code: 'TOO_MANY_REQUESTS' } } },
        meta: { response: new Response('', { headers: { 'Retry-After': '1' } }) },
      }),
    );
    await submit();
    const retry = screen.getByRole('button', { name: '같은 요청 접수 확인' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    await waitFor(() => expect(retry.disabled).toBe(false), { timeout: 2000 });
    expect(state.create).toHaveBeenCalledTimes(1);
  });
  it('저장 불가에도 개인정보를 출력하지 않고 복구 한계를 알린다', async () => {
    setup();
    await review();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private-storage-canary');
    });
    try {
      await submit();
      await screen.findByText('이 탭의 복구 정보를 보관하지 못했습니다. 탭을 닫기 전에 요청 번호와 결과를 확인하세요.');
      expect(document.body.textContent).not.toContain('private-storage-canary');
    } finally {
      storage.mockRestore();
    }
  });
});
