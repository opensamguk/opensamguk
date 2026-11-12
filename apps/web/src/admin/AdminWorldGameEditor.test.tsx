// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminWorldGameEditor } from './AdminWorldGameEditor';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  editor: vi.fn(),
  request: vi.fn(),
  status: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
vi.mock('../trpc', () => ({ useTRPCClient: () => client }));
const router = { invalidate: api.invalidate };
const client = {
  auth: { me: { query: api.me } },
  admin: {
    game: { editor: { query: api.editor }, request: { mutate: api.request }, requestStatus: { query: api.status } },
  },
};
const viewerId = '422143b8-ac7a-4803-a6a0-6d12f82a77a8';
const worldId = '82b78ad7-5fc8-4dc6-8d02-2b12fe5d0334';
const row = {
  id: 32,
  name: '하비',
  population: 100,
  agriculture: 20,
  commerce: 30,
  security: 40,
  defence: 50,
  wall: 60,
  trust: 70,
  nation: null,
};
const cityPage = { target: 'city', next: null, rows: [row] };
const mount = (editable = true) =>
  render(
    <AdminWorldGameEditor
      viewerId={viewerId}
      worldId={worldId}
      worldName="알파 월드"
      editable={editable}
      onClose={vi.fn()}
    />,
  );

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  api.me.mockResolvedValue({ user: { id: viewerId } });
  api.editor.mockResolvedValue(cityPage);
});
afterEach(cleanup);

it('현재 값을 잠금 조건으로 보내고 화면을 다시 열어도 같은 번호로 적용 결과를 확인한다', async () => {
  api.request.mockResolvedValue({ requestId: '51', status: 'PENDING', result: null });
  api.status.mockResolvedValue({ requestId: '51', status: 'APPLIED', result: {} });
  const first = mount();
  fireEvent.change(screen.getByLabelText('편집 대상'), { target: { value: 'city' } });
  fireEvent.click(await screen.findByRole('button', { name: '하비 (32)' }));
  fireEvent.change(screen.getByLabelText('민심 (현재 70)'), { target: { value: '72.5' } });
  fireEvent.change(screen.getByLabelText('운영 사유'), { target: { value: '도시 기록 복구' } });
  fireEvent.click(screen.getByRole('button', { name: '엔진에 요청' }));
  await screen.findByText('운영 요청 51 접수 완료. 엔진 적용을 기다리고 있습니다.');
  const [command] = api.request.mock.calls[0]!;
  expect(command).toMatchObject({
    worldId,
    expectedUserId: viewerId,
    reason: '도시 기록 복구',
    action: { kind: 'admin.city.adjust', cityKey: 32, changes: { trust: { expected: 70, value: 72.5 } } },
  });
  first.unmount();
  api.editor.mockResolvedValue({ target: 'general', next: null, rows: [] });
  mount();
  fireEvent.click(screen.getByRole('button', { name: '적용 결과 조회' }));
  await screen.findByText('운영 요청 51 적용 완료.');
  expect(api.status).toHaveBeenCalledWith({
    worldId,
    expectedUserId: viewerId,
    idempotencyKey: command.idempotencyKey,
  });
  expect(api.request).toHaveBeenCalledOnce();
});

it('계정이 바뀐 조회 결과와 이전 입력을 지운다', async () => {
  mount();
  fireEvent.change(screen.getByLabelText('편집 대상'), { target: { value: 'city' } });
  fireEvent.click(await screen.findByRole('button', { name: '하비 (32)' }));
  fireEvent.change(screen.getByLabelText('운영 사유'), { target: { value: '이전 계정 입력' } });
  fireEvent(window, new Event('blur'));
  expect(screen.queryByRole('button', { name: '하비 (32)' })).toBeNull();
  expect(screen.queryByLabelText('운영 사유')).toBeNull();
  api.me.mockResolvedValue({ user: { id: worldId } });
  fireEvent.click(screen.getByRole('button', { name: '대상 조회' }));
  await screen.findByRole('alert');
  expect(api.invalidate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: '하비 (32)' })).toBeNull();
});

it('종료 월드는 남은 결과를 확인한 뒤에도 새 조치를 열지 않는다', async () => {
  sessionStorage.setItem(`admin.game.editor:${viewerId}:${worldId}`, 'c1550c81-7109-4112-a361-e6bcf51fc30e');
  api.status.mockResolvedValue({ requestId: '52', status: 'APPLIED', result: {} });
  mount(false);
  fireEvent.click(screen.getByRole('button', { name: '적용 결과 조회' }));
  await screen.findByText('운영 요청 52 적용 완료.');
  expect(screen.queryByLabelText('편집 대상')).toBeNull();
  expect(api.editor).not.toHaveBeenCalled();
});
