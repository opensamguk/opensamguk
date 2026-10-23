// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LobbyNotice, LobbyWorld } from './contract';
import { NoticeBoard, WorldList } from './LobbyPage';
import { generalsText, lobbyAction, metaText, myGeneralText, startedText, STATUS_LABEL } from './lobbyView';

afterEach(cleanup);

// AppRouter의 lobby.worlds 응답 모양을 따른 월드 하나. D-025 승인 전 응답이라 maxHumanGenerals 키가 없다.
const world = (extra: Partial<LobbyWorld> = {}): LobbyWorld => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: '1월드',
  status: 'RUNNING',
  presetName: '정규',
  scenarioTitle: '군웅할거',
  startYear: 191,
  gameDate: { year: 193, month: 4 },
  turnTermMinutes: 60,
  startedAt: '2026-10-18T03:00:00.000Z',
  humanGenerals: 34,
  myGeneral: null,
  createBlockedReason: null,
  ...extra,
});

async function renderInRouter(ui: ReactNode) {
  const root = createRootRoute({ component: () => ui });
  const router: AnyRouter = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/lobby'] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole('list');
}

describe('카드 글자', () => {
  it('상태 4종은 글자와 색을 함께 쓴다', () => {
    expect(STATUS_LABEL.RUNNING).toEqual({ text: '진행 중', tone: 'accent' });
    expect(STATUS_LABEL.PREOPEN).toEqual({ text: '가오픈', tone: 'info' });
    expect(STATUS_LABEL.PAUSED).toEqual({ text: '멈춤', tone: 'warning' });
    expect(STATUS_LABEL.ENDED).toEqual({ text: '끝남', tone: 'muted' });
  });

  it('시작일은 월/일, 아직 시작하지 않았으면 시작 전', () => {
    expect(startedText('2026-10-18T03:00:00.000Z')).toBe('시작 10/18');
    expect(startedText(null)).toBe('시작 전');
  });

  it('응답에 정원 키가 없으면(D-025 승인 전) 인원만 쓴다', () => {
    expect('maxHumanGenerals' in world()).toBe(false);
    expect(generalsText(world())).toBe('장수 34');
  });

  it('시나리오·연월·턴 간격·인원·시작일을 한 줄로 잇는다', () => {
    expect(metaText(world())).toEqual(['군웅할거(191)', '193년 4월', '턴 60분', '장수 34', '시작 10/18']);
  });

  it('내 장수는 이름과 국가, 재야면 재야, 없으면 내 장수 없음', () => {
    expect(myGeneralText({ id: 1, name: '조운', nationName: '공손찬' })).toBe('내 장수: 조운 (공손찬)');
    expect(myGeneralText({ id: 1, name: '조운', nationName: null })).toBe('내 장수: 조운 (재야)');
    expect(myGeneralText(null)).toBe('내 장수 없음');
  });
});

describe('버튼 고르기 (T2-04 버튼 표 5줄)', () => {
  const mine = { id: 7, name: '조운', nationName: '공손찬' };
  it('로그인 · 내 장수 있음 · 이유 없음 → 들어가기', () => {
    expect(lobbyAction(true, { myGeneral: mine, createBlockedReason: null })).toEqual({ kind: 'enter' });
  });
  it('로그인 · 내 장수 없음 · 이유 없음 → 장수 만들기', () => {
    expect(lobbyAction(true, { myGeneral: null, createBlockedReason: null })).toEqual({
      kind: 'create',
      blocked: null,
    });
  });
  it('로그인 · 내 장수 없음 · 이유 있음 → 막힌 장수 만들기와 이유', () => {
    expect(lobbyAction(true, { myGeneral: null, createBlockedReason: '장수를 만드는 중입니다' })).toEqual({
      kind: 'create',
      blocked: '장수를 만드는 중입니다',
    });
  });
  it('무인증 · 이유 없음 → 로그인하고 참가', () => {
    expect(lobbyAction(false, { myGeneral: null, createBlockedReason: null })).toEqual({
      kind: 'login',
      blocked: null,
    });
  });
  it('무인증 · 이유 있음 → 막힌 로그인하고 참가와 이유', () => {
    expect(lobbyAction(false, { myGeneral: null, createBlockedReason: '멈춘 월드입니다' })).toEqual({
      kind: 'login',
      blocked: '멈춘 월드입니다',
    });
  });
  it('상태로 버튼을 추측하지 않는다. 멈춤 월드도 내 장수가 있으면 들어가기', () => {
    expect(lobbyAction(true, { myGeneral: mine, createBlockedReason: null })).toEqual({ kind: 'enter' });
  });
});

// 첫 라우터 렌더는 느린 기계에서 5초를 넘기기도 한다.
describe('월드 카드', { timeout: 30_000 }, () => {
  it('카드마다 상태·프리셋·이름·요약과 버튼을 그린다', async () => {
    await renderInRouter(
      <WorldList
        loggedIn
        worlds={[
          world({ myGeneral: { id: 7, name: '조운', nationName: '공손찬' } }),
          world({
            id: '00000000-0000-4000-8000-000000000002',
            name: '2월드',
            status: 'PREOPEN',
            presetName: null,
            startedAt: null,
            humanGenerals: 0,
            createBlockedReason: '아직 열리지 않은 월드입니다',
          }),
        ]}
      />,
    );
    const first = screen.getByRole('article', { name: '1월드' });
    expect(within(first).getByText('진행 중').getAttribute('data-tone')).toBe('accent');
    expect(within(first).getByText('정규')).toBeTruthy();
    expect(within(first).getByText('군웅할거(191) · 193년 4월 · 턴 60분 · 장수 34 · 시작 10/18')).toBeTruthy();
    expect(within(first).getByText('내 장수: 조운 (공손찬)')).toBeTruthy();
    expect(within(first).getByRole('link', { name: '들어가기' }).getAttribute('href')).toBe(
      '/w/00000000-0000-4000-8000-000000000001',
    );

    const second = screen.getByRole('article', { name: '2월드' });
    expect(within(second).getByText('가오픈').getAttribute('data-tone')).toBe('info');
    expect(within(second).queryByText('정규')).toBeNull();
    expect(within(second).getByText(/시작 전$/)).toBeTruthy();
    expect(within(second).queryByRole('link')).toBeNull();
    const blocked = within(second).getByRole('button', { name: /^장수 만들기\s*\(사용 불가\)$/ });
    fireEvent.click(blocked);
    expect(within(second).getByRole('note').textContent).toBe('아직 열리지 않은 월드입니다');
  });

  it('장수 만들기는 생성 화면, 무인증은 로그인 뒤 로비로 돌아온다', async () => {
    await renderInRouter(<WorldList loggedIn worlds={[world()]} />);
    expect(screen.getByRole('link', { name: '장수 만들기' }).getAttribute('href')).toBe(
      '/w/00000000-0000-4000-8000-000000000001/create',
    );
    cleanup();
    await renderInRouter(<WorldList loggedIn={false} worlds={[world()]} />);
    expect(screen.getByRole('link', { name: '로그인하고 참가' }).getAttribute('href')).toBe('/login?next=%2Flobby');
  });

  // PR183 E2E 반례: 월드 이름에 상태 글자가 들어 있으면 부분 일치로는 배지와 제목을 함께 잡는다.
  it('월드 이름에 상태 글자가 있어도 상태 배지는 하나이고 색을 가진다', async () => {
    await renderInRouter(
      <WorldList
        loggedIn
        worlds={[
          world({
            name: 'E2E 가오픈 1',
            status: 'PREOPEN',
            startedAt: null,
            createBlockedReason: '아직 열리지 않은 월드입니다',
          }),
          world({
            id: '00000000-0000-4000-8000-000000000002',
            name: 'E2E 멈춤 2',
            status: 'PAUSED',
            createBlockedReason: '멈춘 월드입니다',
          }),
        ]}
      />,
    );
    for (const [name, text, tone] of [
      ['E2E 가오픈 1', '가오픈', 'info'],
      ['E2E 멈춤 2', '멈춤', 'warning'],
    ] as const) {
      const card = screen.getByRole('article', { name });
      expect(within(card).getAllByText(new RegExp(text))).toHaveLength(2);
      const badges = within(card).getAllByText(text, { exact: true });
      expect(badges).toHaveLength(1);
      expect(badges[0]!.getAttribute('data-tone')).toBe(tone);
      expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe(name);
    }
  });

  it('끝난 월드가 오면 끝남으로 쓴다', async () => {
    await renderInRouter(
      <WorldList loggedIn worlds={[world({ status: 'ENDED', createBlockedReason: '끝난 월드입니다' })]} />,
    );
    expect(screen.getByText('끝남').getAttribute('data-tone')).toBe('muted');
  });
});

describe('공지', () => {
  const notices: LobbyNotice[] = [
    { id: 'n2', title: '2월드 가오픈', body: '다음 주에 엽니다.', publishedAt: '2026-10-20T03:00:00.000Z' },
    { id: 'n1', title: '점검 안내', body: '오늘 밤 점검합니다.', publishedAt: '2026-10-19T03:00:00.000Z' },
  ];

  it('서버 순서 그대로 두고 첫 줄만 펼친다. 한 번에 하나만 연다', () => {
    render(<NoticeBoard notices={notices} />);
    const [first, second] = screen.getAllByRole('button');
    expect(first!.textContent).toContain('2월드 가오픈');
    expect(first!.getAttribute('aria-expanded')).toBe('true');
    expect(second!.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('다음 주에 엽니다.').hidden).toBe(false);
    expect(screen.getByText('오늘 밤 점검합니다.').hidden).toBe(true);

    fireEvent.click(second!);
    expect(first!.getAttribute('aria-expanded')).toBe('false');
    expect(second!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('다음 주에 엽니다.').hidden).toBe(true);
  });
});
