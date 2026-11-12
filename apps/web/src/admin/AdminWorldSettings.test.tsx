// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminWorldSettings } from './AdminWorldSettings';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  settings: vi.fn(),
  mutate: vi.fn(),
  result: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
vi.mock('../trpc', () => ({ useTRPCClient: () => client }));
const router = { invalidate: api.invalidate };
const client = {
  auth: { me: { query: api.me } },
  admin: {
    world: {
      settings: { query: api.settings },
      requestSetting: { mutate: api.mutate },
      settingRequest: { query: api.result },
    },
  },
};
const viewerId = '422143b8-ac7a-4803-a6a0-6d12f82a77a8';
const worldId = '82b78ad7-5fc8-4dc6-8d02-2b12fe5d0334';
const settings = {
  name: '알파 월드',
  status: 'PAUSED',
  startYear: 191,
  endYear: 231,
  turnTermMinutes: 60,
  clockRevision: 8,
  presetKey: 'regular',
  canChangeRules: true,
  canChangeNpcPlay: true,
  rules: {
    protection: { foundUntilMonths: 36, peaceMonths: 12, maxGeneralsPerNation: null },
    npc: { aggression: 1 },
    boost: { smallWorld: null, lateJoin: null },
  },
  entry: { generalCreation: 'open', npcPlay: 'off' },
  truce: null,
};

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  api.me.mockResolvedValue({ user: { id: viewerId } });
  api.settings.mockResolvedValue(settings);
});
afterEach(cleanup);

it('일시정지 월드의 NPC 플레이를 요청하고 같은 번호로 엔진 적용을 확인한다', async () => {
  const applied = vi.fn();
  api.mutate.mockResolvedValue({ requestId: '12', status: 'PENDING', result: null });
  api.result.mockResolvedValue({ requestId: '12', status: 'APPLIED', result: {} });
  render(<AdminWorldSettings viewerId={viewerId} worldId={worldId} onClose={vi.fn()} onApplied={applied} />);
  fireEvent.click(await screen.findByRole('button', { name: 'NPC 무장 플레이 금지' }));
  fireEvent.change(screen.getByLabelText('NPC 무장 플레이'), { target: { value: 'on' } });
  fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '알파에서 NPC 플레이 허용' } });
  fireEvent.click(screen.getByRole('button', { name: '변경 요청' }));
  await screen.findByText('변경 요청 12 접수 완료. 엔진 적용을 기다리고 있습니다.');
  const [command] = api.mutate.mock.calls[0]!;
  expect(command).toMatchObject({
    worldId,
    expectedUserId: viewerId,
    reason: '알파에서 NPC 플레이 허용',
    setting: { kind: 'admin.world.setOption', key: 'entry.npcPlay', value: 'on' },
  });
  expect(applied).not.toHaveBeenCalled();
  api.settings.mockResolvedValue({ ...settings, entry: { ...settings.entry, npcPlay: 'on' } });
  fireEvent.click(screen.getByRole('button', { name: '적용 결과 조회' }));
  expect(await screen.findByRole('button', { name: 'NPC 무장 플레이 허용' })).toBeTruthy();
  expect(api.result).toHaveBeenCalledWith({
    worldId,
    expectedUserId: viewerId,
    idempotencyKey: command.idempotencyKey,
  });
  expect(applied).toHaveBeenCalledOnce();
});

it('진행 중인 월드의 턴 간격은 정수 분으로 보내고 잘못된 간격은 접수하지 않는다', async () => {
  api.settings.mockResolvedValue({ ...settings, status: 'RUNNING' });
  api.mutate.mockResolvedValue({ requestId: '13', status: 'PENDING', result: null });
  render(<AdminWorldSettings viewerId={viewerId} worldId={worldId} onClose={vi.fn()} onApplied={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '턴 간격 (분) 60' }));
  const term = screen.getByLabelText('턴 간격 (분)');
  fireEvent.change(term, { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('변경 사유'), { target: { value: '테스트 운영' } });
  fireEvent.click(screen.getByRole('button', { name: '변경 요청' }));
  expect(screen.getByText('변경 값과 사유를 확인하세요.')).toBeTruthy();
  expect(api.mutate).not.toHaveBeenCalled();
  fireEvent.change(term, { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: '변경 요청' }));
  await waitFor(() =>
    expect(api.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        setting: { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 },
      }),
    ),
  );
});

it('조회 사이 월드가 종료되면 변경을 열 수 없다', async () => {
  api.settings.mockResolvedValue({ ...settings, status: 'ENDED' });
  render(<AdminWorldSettings viewerId={viewerId} worldId={worldId} onClose={vi.fn()} onApplied={vi.fn()} />);
  const button = (await screen.findByRole('button', { name: 'NPC 무장 플레이 금지' })) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByRole('button', { name: '변경 요청' })).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});

it('접수가 확인되지 않은 영수증은 번호를 보존한다', async () => {
  const id = 'c1550c81-7109-4112-a361-e6bcf51fc30e';
  const storageKey = `admin.world.setting:${viewerId}:${worldId}`;
  sessionStorage.setItem(storageKey, id);
  api.result.mockRejectedValue(
    new TRPCClientError('not found', {
      result: { error: { code: -32004, message: 'not found', data: { code: 'NOT_FOUND' } } },
    }),
  );
  render(<AdminWorldSettings viewerId={viewerId} worldId={worldId} onClose={vi.fn()} onApplied={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '적용 결과 조회' }));
  await screen.findByText('접수 여부를 아직 확인하지 못했습니다. 다시 조회하거나 감사 기록에서 확인하세요.');
  expect(sessionStorage.getItem(storageKey)).toBe(id);
  expect(api.mutate).not.toHaveBeenCalled();
});
