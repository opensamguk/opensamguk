// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminWorlds } from './AdminWorlds';

const state = vi.hoisted(() => ({
  viewerId: 'viewer-a',
  clock: vi.fn(),
  end: vi.fn(),
  create: vi.fn(),
  reset: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouteContext: () => ({ adminViewerId: state.viewerId }),
}));
vi.mock('../trpc', () => ({ useTRPCClient: () => ({}) }));
vi.mock('./usePrivateRead', () => ({
  usePrivateRead: () => ({ data: null, pending: false, error: null, clear: state.clear }),
}));
vi.mock('./AdminClockActions', () => ({
  AdminClockActions: (props: unknown) => {
    state.clock(props);
    return <span data-testid="clock-panel" />;
  },
}));
vi.mock('./AdminEndActions', () => ({
  AdminEndActions: (props: unknown) => {
    state.end(props);
    return <span data-testid="end-panel" />;
  },
}));
vi.mock('./AdminCreateActions', () => ({
  AdminCreateActions: (props: unknown) => {
    state.create(props);
    return <span data-testid="create-panel" />;
  },
}));
vi.mock('./AdminResetActions', () => ({
  AdminResetActions: (props: unknown) => {
    state.reset(props);
    return <span data-testid="reset-panel" />;
  },
}));

const kinds = ['clock', 'end', 'create', 'reset'] as const;
type Kind = (typeof kinds)[number];
function actions(kind: Exclude<Kind, 'clock'>) {
  return state[kind].mock.lastCall![0] as { disabled: boolean; onAcquire: () => boolean; onRelease: () => void };
}
function clock() {
  return state.clock.mock.lastCall![0] as { onLockChange: (locked: boolean) => void };
}
function release(kind: Kind) {
  if (kind === 'clock') clock().onLockChange(false);
  else actions(kind).onRelease();
}
function expectOwner(owner: Kind | null) {
  for (const kind of kinds) {
    const blocked = owner !== null && owner !== kind;
    const wrapper = screen.getByTestId(`${kind}-panel`).parentElement!;
    expect(wrapper.hasAttribute('inert')).toBe(blocked);
    expect(wrapper.getAttribute('aria-hidden')).toBe(blocked ? 'true' : null);
    if (kind !== 'clock') expect(actions(kind).disabled).toBe(blocked);
  }
  expect((screen.getByRole('button', { name: '월드 조회' }) as HTMLButtonElement).disabled).toBe(owner !== null);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.viewerId = 'viewer-a';
});
afterEach(cleanup);

describe('AC-M3-04 월드 시계·종료·생성·초기화 공유 잠금', () => {
  it.each(kinds)('%s가 잠그면 나머지 세 패널을 막고 다른 패널의 해제는 무시한다', (kind) => {
    render(<AdminWorlds />);
    expectOwner(null);
    expect(screen.queryByText(/화면은 .*준비 중입니다/)).toBeNull();
    act(() => {
      if (kind === 'clock') clock().onLockChange(true);
      else expect(actions(kind).onAcquire()).toBe(true);
    });
    expectOwner(kind);
    act(() => {
      for (const other of kinds.filter((value) => value !== kind)) {
        if (other === 'clock') clock().onLockChange(true);
        else expect(actions(other).onAcquire()).toBe(false);
        release(other);
      }
    });
    expectOwner(kind);
    act(() => release(kind));
    expectOwner(null);
  });

  it('렌더가 정착하기 전에도 생성이 획득한 잠금을 초기화·종료·시계가 덮어쓰지 못한다', () => {
    render(<AdminWorlds />);
    act(() => {
      expect(actions('create').onAcquire()).toBe(true);
      expect(actions('reset').onAcquire()).toBe(false);
      release('reset');
      expect(actions('end').onAcquire()).toBe(false);
      clock().onLockChange(true);
      expect(actions('create').onAcquire()).toBe(true);
    });
    expectOwner('create');
  });

  it('관리자 계정이 바뀌면 이전 패널의 잠금과 비활성 표시를 초기화한다', () => {
    const view = render(<AdminWorlds />);
    act(() => expect(actions('reset').onAcquire()).toBe(true));
    expectOwner('reset');
    state.viewerId = 'viewer-b';
    view.rerender(<AdminWorlds />);
    expectOwner(null);
  });
});
