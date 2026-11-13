// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_PANELS,
  MobileMainBar,
  MobileTabPanel,
  panelFromHash,
  panelHash,
  panelOfArea,
  useMainPanel,
  type MobilePanel,
} from './MobileMainTabs';

afterEach(cleanup);

describe('375px 메인 패널 주소', () => {
  it('해시로 패널을 정하고 모르는 값과 빈 해시는 지도다', () => {
    expect(panelFromHash('')).toBe('map');
    expect(panelFromHash('main-commands')).toBe('commands');
    expect(panelFromHash('#main-commands')).toBe('commands');
    expect(panelFromHash('main-status')).toBe('status');
    expect(panelFromHash('main-records')).toBe('records');
    expect(panelFromHash('main-messages')).toBe('messages');
    expect(panelFromHash('main-menu')).toBe('menu');
    expect(panelFromHash('main-nope')).toBe('map');
    expect(panelFromHash('cities')).toBe('map');
  });

  it('칸 이름(머리글 id)도 그 칸이 있는 패널로 연다', () => {
    expect(panelFromHash('main-city')).toBe('status');
    expect(panelFromHash('main-nation')).toBe('status');
    expect(panelFromHash('main-general')).toBe('status');
    expect(panelFromHash('main-general-records')).toBe('records');
    expect(panelOfArea('world-records')).toBe('records');
    expect(panelOfArea('map')).toBe('map');
  });

  it('패널마다 해시가 하나이고 다시 읽으면 같은 패널이다', () => {
    expect(MOBILE_PANELS.map((item) => item.label)).toEqual(['지도', '예턴', '현황', '기록', '메시지', '메뉴']);
    for (const { key } of MOBILE_PANELS) expect(panelFromHash(panelHash(key))).toBe(key);
    expect(panelHash('map')).toBe('');
  });
});

describe('375px 메인 하단 막대', () => {
  it('탭 6개 중 고른 패널만 aria-selected이고 Tab 순서에 들어간다', () => {
    render(<MobileMainBar active="commands" onSelect={() => undefined} />);
    expect(screen.getByRole('tablist', { name: '메인 화면' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['지도', '예턴', '현황', '기록', '메시지', '메뉴']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    // 현황은 도시·국가·장수 세 칸을 함께 연다.
    expect(screen.getByRole('tab', { name: '현황' }).getAttribute('aria-controls')).toBe(
      'main-panel-status-city main-panel-status-nation main-panel-status-general',
    );
    expect(screen.getByRole('tab', { name: '예턴' }).getAttribute('aria-controls')).toBe('main-panel-commands');
  });

  it('누르면 그 패널을 고르고, 화살표·Home·End는 초점만 옮긴다', () => {
    const onSelect = vi.fn();
    render(<MobileMainBar active="map" onSelect={onSelect} />);
    const map = screen.getByRole('tab', { name: '지도' });
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '예턴' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '메뉴' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(map);
    fireEvent.keyDown(map, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '메뉴' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(map);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '메시지' }));
    expect(onSelect).toHaveBeenCalledWith('messages');
  });

  it('예턴 저장 상태와 안 읽은 메시지 수를 표로 얹되 탭 이름은 그대로 둔다', () => {
    render(
      <>
        <span id="turn-status">저장하지 않은 편집 2건</span>
        <MobileMainBar
          active="map"
          onSelect={() => undefined}
          notes={{
            commands: { badge: '2', status: 'unsaved', describedBy: 'turn-status' },
            messages: { badge: '3', danger: true },
          }}
        />
      </>,
    );
    const turns = screen.getByRole('tab', { name: '예턴' });
    expect(turns.getAttribute('data-status')).toBe('unsaved');
    expect(turns.getAttribute('aria-describedby')).toBe('turn-status');
    expect(turns.querySelector('[aria-hidden="true"]')?.textContent).toBe('2');
    const messages = screen.getByRole('tab', { name: '메시지' });
    expect(messages.querySelector('[data-danger="true"]')?.textContent).toBe('3');
    expect(screen.getByRole('tab', { name: '지도' }).querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('패널 묶음은 좁은 화면에서만 tabpanel이고 고른 패널 표시를 단다', () => {
    const { rerender } = render(
      <MobileTabPanel panel="status" part="city" active="status" narrow>
        도시
      </MobileTabPanel>,
    );
    const city = screen.getByRole('tabpanel');
    expect(city.id).toBe('main-panel-status-city');
    expect(city.getAttribute('aria-labelledby')).toBe('main-tab-status');
    expect(city.getAttribute('data-active')).toBe('true');
    rerender(
      <MobileTabPanel panel="status" part="city" active="map" narrow={false}>
        도시
      </MobileTabPanel>,
    );
    expect(screen.queryByRole('tabpanel')).toBeNull();
    const wide = screen.getByText('도시');
    expect(wide.getAttribute('data-active')).toBe('false');
    expect(wide.getAttribute('aria-labelledby')).toBeNull();
  });
});

// 실제 주소(메모리 기록)로 패널 바꾸기를 본다. 막대·패널·고른 도시 검색값·초안 상태가 함께 있는 작은 메인이다.
function Harness({ onArrive, onOpen }: { onArrive: (hash: string) => void; onOpen: () => void }) {
  const { panel, openPanel } = useMainPanel({ scope: 'w1', onArrive, onOpen });
  // 패널을 바꿔도 내리지 않는 칸의 상태(예턴 편집 초안 대신)
  const [draft, setDraft] = useState(0);
  const tab = (key: MobilePanel, text: string) => (
    <MobileTabPanel panel={key} active={panel} narrow>
      {text}
    </MobileTabPanel>
  );
  return (
    <>
      {tab('map', '지도 칸')}
      <MobileTabPanel panel="commands" active={panel} narrow>
        <button type="button" onClick={() => setDraft((n) => n + 1)}>
          편집 {draft}건
        </button>
      </MobileTabPanel>
      {tab('menu', '메뉴 칸')}
      <button type="button" onClick={() => openPanel('commands', () => onArrive('then'))}>
        명령 칸으로
      </button>
      <MobileMainBar active={panel} onSelect={(next) => openPanel(next)} />
    </>
  );
}

async function renderHarness(path: string) {
  const onArrive = vi.fn();
  const onOpen = vi.fn();
  const root = createRootRoute();
  const main = createRoute({
    getParentRoute: () => root,
    path: '/w/$worldId',
    component: () => <Harness onArrive={onArrive} onOpen={onOpen} />,
  });
  const other = createRoute({ getParentRoute: () => root, path: '/w/$worldId/records' });
  const history: RouterHistory = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren([main, other]), history });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return { router, history, onArrive, onOpen };
}

const activePanel = () => document.querySelector('[data-active="true"]')?.getAttribute('data-mobile-panel');

describe('375px 메인 패널 바꾸기', () => {
  it('탭을 누르면 해시만 바꾸고(?city 유지, 기록 안 쌓음) 패널 처음으로 간다', async () => {
    const { router, history, onArrive, onOpen } = await renderHarness('/w/w1?city=40');
    expect(activePanel()).toBe('map');
    expect(onArrive).toHaveBeenCalledWith('');
    const length = history.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '예턴' }));
    });
    expect(router.state.location.hash).toBe('main-commands');
    expect(router.state.location.search).toEqual({ city: 40 });
    expect(history.length).toBe(length);
    expect(activePanel()).toBe('commands');
    expect(screen.getByRole('tab', { name: '예턴' }).getAttribute('aria-selected')).toBe('true');
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 탭으로 바꾼 것은 주소로 들어온 것이 아니다.
    expect(onArrive).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '지도' }));
    });
    expect(router.state.location.hash).toBe('');
    expect(router.state.location.search).toEqual({ city: 40 });
    expect(activePanel()).toBe('map');
    // 이미 고른 탭을 다시 누르면 주소는 그대로이고 패널 처음으로만 간다.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '지도' }));
    });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('숨긴 패널도 내리지 않아 패널을 오가도 칸의 상태가 남는다', async () => {
    await renderHarness('/w/w1#main-commands');
    expect(activePanel()).toBe('commands');
    fireEvent.click(screen.getByRole('button', { name: '편집 0건' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '메뉴' }));
    });
    expect(activePanel()).toBe('menu');
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '예턴' }));
    });
    expect(screen.getByRole('button', { name: '편집 1건' })).toBeTruthy();
  });

  it('주소의 해시로 들어오면(새로고침·뒤로 가기) 그 패널을 열고 onArrive를 부른다', async () => {
    const { router, onArrive } = await renderHarness('/w/w1?city=3#main-menu');
    expect(activePanel()).toBe('menu');
    expect(onArrive).toHaveBeenLastCalledWith('main-menu');
    await act(async () => {
      router.history.push('/w/w1/records');
      await router.load();
    });
    await act(async () => {
      router.history.back();
      await router.load();
    });
    expect(router.state.location.hash).toBe('main-menu');
    expect(activePanel()).toBe('menu');
    expect(onArrive).toHaveBeenLastCalledWith('main-menu');
  });

  it('다른 패널의 칸으로 가면 패널을 바꾼 뒤에 이어서 할 일을 부른다', async () => {
    const { onArrive, onOpen } = await renderHarness('/w/w1');
    onArrive.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '명령 칸으로' }));
    });
    expect(activePanel()).toBe('commands');
    expect(onArrive.mock.calls).toEqual([['then']]);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
