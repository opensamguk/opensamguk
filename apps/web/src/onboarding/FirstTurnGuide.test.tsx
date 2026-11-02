// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstTurnGuide } from './FirstTurnGuide';
import { dismissGuide, isGuideDismissed, lastWorld, resetGuide, sessionMemory } from './guideStorage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  sessionMemory.dismissed.clear();
  sessionMemory.lastWorld = null;
});

const dialog = () => screen.queryByRole('dialog');
const title = () => screen.getByRole('heading', { level: 2 }).textContent;

describe('첫 턴 안내', () => {
  it('장수가 있는 메인에서 처음 한 번 띄우고 닫으면 이 월드에서는 다시 띄우지 않는다', () => {
    const first = render(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(title()).toBe('지도에서 내 도시를 찾으세요');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
    fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('opensamguk:first-turn-guide:w1')).toBe('1');
    first.unmount();

    render(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()).toBeNull();
    cleanup();
    // 다른 월드는 따로 센다.
    render(<FirstTurnGuide worldId="w2" show />);
    expect(dialog()).not.toBeNull();
  });

  it('장수가 없거나 메인이 아니면 띄우지 않고 마지막 월드만 적는다', () => {
    const view = render(<FirstTurnGuide worldId="w1" show={false} />);
    expect(dialog()).toBeNull();
    expect(lastWorld()).toBe('w1');
    view.rerender(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()).not.toBeNull();
  });

  it('이전·다음으로 세 단계를 오가고 지금 단계를 표시한다', () => {
    render(<FirstTurnGuide worldId="w1" show />);
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(title()).toBe('예턴에 첫 명령을 넣으세요');
    expect(screen.getByText(/예턴은 30칸입니다/)).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('예턴 넣기');
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(title()).toBe('저장해야 명령이 실행됩니다');
    expect(screen.queryByRole('button', { name: '다음' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
    fireEvent.click(screen.getByRole('button', { name: '이전' }));
    expect(title()).toBe('예턴에 첫 명령을 넣으세요');
  });

  it('Esc로 닫고 연 자리로 초점을 돌려준다', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    render(<FirstTurnGuide worldId="w1" show />);
    expect(document.activeElement).not.toBe(opener);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(isGuideDismissed('w1')).toBe(true);
    opener.remove();
  });

  it('Tab은 안내 안의 단추 사이에서만 돈다', () => {
    render(<FirstTurnGuide worldId="w1" show />);
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    const previous = screen.getByRole('button', { name: '이전' });
    const close = screen.getByRole('button', { name: '안내 닫기' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(previous);
    fireEvent.keyDown(previous, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    screen.getByRole('heading', { level: 2 }).focus();
    fireEvent.keyDown(screen.getByRole('heading', { level: 2 }), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('저장소가 막혀도 깨지지 않고 이 탭에서 한 번만 띄운다', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('막힘');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('막힘');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('막힘');
    });
    const first = render(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
    expect(dialog()).toBeNull();
    first.unmount();
    render(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()).toBeNull();
    expect(lastWorld()).toBe('w1');
    resetGuide('w1');
    expect(isGuideDismissed('w1')).toBe(false);
  });

  it('도움말에서 기록을 지우면 다시 띄운다', () => {
    dismissGuide('w1');
    resetGuide('w1');
    render(<FirstTurnGuide worldId="w1" show />);
    expect(dialog()).not.toBeNull();
  });
});
