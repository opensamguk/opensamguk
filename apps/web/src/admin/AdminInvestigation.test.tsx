// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminInvestigation,
  maskedInvestigationGroups,
  type InvestigationGroup,
  type InvestigationSource,
} from './AdminInvestigation';
import { AdminUserDetail } from './AdminUserDetail';
import type { ComponentProps } from 'react';

const viewer = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const world = '20000000-0000-4000-8000-000000000001';
const groups: InvestigationGroup[] = [
  {
    kind: 'IP',
    label: 'aabbccdd',
    users: [
      { userId: viewer, generalId: 492, generalName: '<img src=x>', logins: 3, lastAt: '2026-10-29T01:02:03Z' },
      { userId: other, generalId: 493, generalName: '조사장수', logins: 1, lastAt: '2026-10-29T01:02:04Z' },
    ],
  },
];
function source(): InvestigationSource {
  return {
    me: vi.fn(async () => ({ user: { id: viewer } })),
    whoami: vi.fn(async () => ({ admin: true as const })),
    worlds: vi.fn(async () => [{ id: world, name: '정식 월드', status: 'RUNNING' }]),
    shared: vi.fn(async () => groups),
  };
}
async function prepare() {
  fireEvent.click(screen.getByRole('button', { name: '조사할 월드 목록 조회' }));
  await screen.findByRole('option', { name: '정식 월드 · RUNNING' });
  fireEvent.change(screen.getByRole('combobox', { name: '조사할 월드' }), { target: { value: world } });
  fireEvent.click(screen.getByRole('checkbox', { name: '필요한 월드와 기간의 개인정보만 확인합니다.' }));
}
const readButton = () => screen.getByRole('button', { name: '공유 기록 조회' });
afterEach(cleanup);

describe('AC-M3-05 조사 화면의 로컬 표시·읽기 경계 (실제 API 인수와 구분)', () => {
  it('자동 조회하지 않고 명시한 월드·기간과 확인을 보낸 뒤 가린 자료를 텍스트로 표시한다', async () => {
    const data = source(),
      denied = vi.fn();
    const view = render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={denied} />);
    expect(data.me).not.toHaveBeenCalled();
    expect(data.shared).not.toHaveBeenCalled();
    await prepare();
    fireEvent.click(readButton());
    await screen.findByText('공유 묶음 1개');
    expect(data.shared).toHaveBeenCalledWith({ worldId: world, days: 7 }, expect.any(AbortSignal));
    expect(data.me).toHaveBeenCalledTimes(4);
    expect(data.whoami).toHaveBeenCalledTimes(4);
    expect(screen.getByText('<img src=x> · 장수 492').textContent).toBe('<img src=x> · 장수 492');
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('aabbccdd')).toBeTruthy();
    expect(denied).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '조회 기간 (일)' }), { target: { value: '90' } });
    expect(screen.queryByText('공유 묶음 1개')).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('1~90일 밖의 입력은 조회하지 않는다', async () => {
    const data = source();
    render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={vi.fn()} />);
    await prepare();
    fireEvent.change(screen.getByRole('spinbutton', { name: '조회 기간 (일)' }), { target: { value: '91' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(readButton());
    await screen.findByRole('alert');
    expect(data.shared).not.toHaveBeenCalled();
  });

  it('빈 결과와 실패를 구별하고 실패에 서버 오류 원문을 표시하지 않는다', async () => {
    const data = source();
    data.shared = vi.fn(async () => []);
    render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={vi.fn()} />);
    await prepare();
    fireEvent.click(readButton());
    await screen.findByText('선택한 월드와 기간에 두 계정 이상이 공유한 기록이 없습니다.');
    data.shared = vi.fn(async () => {
      throw new Error('private internal response');
    });
    fireEvent.click(readButton());
    await screen.findByRole('alert');
    expect(screen.queryByText('공유 묶음 0개')).toBeNull();
    expect(document.body.textContent?.includes('private internal response')).toBe(false);
  });

  it('조회와 함께 받은 신원 또는 조회 뒤 신원이 다르면 자료를 버린다', async () => {
    for (const changedAt of [3, 4]) {
      const data = source(),
        denied = vi.fn();
      let calls = 0;
      data.me = vi.fn(async () => ({ user: { id: ++calls === changedAt ? other : viewer } }));
      const view = render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={denied} />);
      await prepare();
      fireEvent.click(readButton());
      await waitFor(() => expect(denied).toHaveBeenCalledOnce());
      expect(screen.queryByText('aabbccdd')).toBeNull();
      expect(screen.queryByRole('option', { name: '정식 월드 · RUNNING' })).toBeNull();
      view.unmount();
    }
  });

  it('조회 취소와 창 전환은 신호를 중단하고 늦은 결과를 버린다', async () => {
    for (const mode of ['cancel', 'blur'] as const) {
      const data = source();
      let complete!: (value: InvestigationGroup[]) => void, signal: AbortSignal | undefined;
      data.shared = vi.fn((input, received) => {
        void input;
        signal = received;
        return new Promise<InvestigationGroup[]>((resolve) => {
          complete = resolve;
        });
      });
      const view = render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={vi.fn()} />);
      await prepare();
      fireEvent.click(readButton());
      await screen.findByText('조사 자료 조회 중');
      if (mode === 'cancel') fireEvent.click(screen.getByRole('button', { name: '조회 취소' }));
      else fireEvent(window, new Event('blur'));
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        complete(groups);
      });
      expect(screen.queryByText('aabbccdd')).toBeNull();
      view.unmount();
    }
  });

  it('관리자 계정이 바뀌면 이전 화면과 대기 결과를 즉시 숨긴다', async () => {
    const data = source();
    let complete!: (value: InvestigationGroup[]) => void;
    data.shared = vi.fn(
      () =>
        new Promise<InvestigationGroup[]>((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={vi.fn()} />);
    await prepare();
    fireEvent.click(readButton());
    await screen.findByText('조사 자료 조회 중');
    view.rerender(<AdminInvestigation viewerId={other} source={data} onAccessDenied={vi.fn()} />);
    expect(screen.queryByRole('option', { name: '정식 월드 · RUNNING' })).toBeNull();
    await act(async () => {
      complete(groups);
    });
    expect(screen.queryByText('aabbccdd')).toBeNull();
  });

  it('전체 해시·IP·중복 사용자 등 잘못된 자료를 DOM에 싣지 않는다', async () => {
    for (const label of ['a'.repeat(64), '192.0.2.1', '<script>']) {
      const data = source();
      data.shared = vi.fn(async () => [{ ...groups[0]!, label }]);
      const view = render(<AdminInvestigation viewerId={viewer} source={data} onAccessDenied={vi.fn()} />);
      await prepare();
      fireEvent.click(readButton());
      await screen.findByRole('alert');
      expect(document.body.textContent?.includes(label)).toBe(false);
      view.unmount();
    }
    expect(() =>
      maskedInvestigationGroups([{ ...groups[0]!, users: [groups[0]!.users[0]!, groups[0]!.users[0]!] }]),
    ).toThrow('조사 자료 형식');
  });

  const detail = (): NonNullable<ComponentProps<typeof AdminUserDetail>['data']> => ({
    userId: viewer,
    email: 'viewer@example.test',
    status: 'ACTIVE',
    role: 'USER',
    createdAt: '2026-10-29T01:00:00Z',
    emailVerified: true,
    generalCount: 0,
    sanctionCount: 0,
    generals: [],
    sanctions: [],
    recentLogins: [
      { at: '2026-10-29T01:02:03Z', success: true, ipLabel: 'aabbccdd', deviceLabel: null },
      { at: '2026-10-29T01:02:02Z', success: false, ipLabel: 'aabbccdd', deviceLabel: '11223344' },
    ],
  });
  it('최근 기록을 성공·실패·가림 이름으로 표시하고 기존 사용자 상세를 유지한다', () => {
    render(
      <AdminUserDetail
        userId={viewer}
        onChange={vi.fn()}
        onRead={vi.fn()}
        data={detail()}
        pending={false}
        error={null}
      />,
    );
    expect(screen.getByText('viewer@example.test')).toBeTruthy();
    expect(screen.getByText('ACTIVE · USER')).toBeTruthy();
    expect(screen.getByRole('list', { name: '최근 로그인 기록 목록' }).children).toHaveLength(2);
    expect(screen.getByText('11223344')).toBeTruthy();
    expect(screen.getByText('기기 가림 이름 기록 없음')).toBeTruthy();
    expect(screen.getByText('참가 장수가 없습니다.')).toBeTruthy();
  });

  it('최근 기록의 전체 해시나 잘못된 시각은 표시하지 않는다', () => {
    const value = detail();
    value.recentLogins[0]!.ipLabel = 'b'.repeat(64);
    render(
      <AdminUserDetail userId={viewer} onChange={vi.fn()} onRead={vi.fn()} data={value} pending={false} error={null} />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(document.body.textContent?.includes(value.recentLogins[0]!.ipLabel)).toBe(false);
    expect(screen.queryByRole('list', { name: '최근 로그인 기록 목록' })).toBeNull();
  });
});
