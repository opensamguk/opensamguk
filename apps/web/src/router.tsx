import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouter,
} from '@tanstack/react-router';
import { BattleSimPage } from './battleSim/BattleSimPage';
import { DiplomacyPage, parseDiplomacySearch } from './diplomacy/DiplomacyPage';
import { CreateGeneralPage } from './general/CreateGeneralPage';
import { HelpPage } from './help/HelpPage';
import { GameLayout } from './layout/GameLayout';
import { LobbyPage } from './lobby/LobbyPage';
import { MessagesPage } from './messages/MessagesPage';
import { NotificationSettingsPage } from './notifications/NotificationSettingsPage';
import { DevUiPage } from './pages/DevUiPage';
import { LoginPage } from './pages/LoginPage';
import { MainPage } from './pages/MainPage';
import { SignupPage } from './pages/SignupPage';
import { NationTurnsPage } from './personnel/NationTurnsPage';
import { PersonnelPage } from './personnel/PersonnelPage';
import { CityPage, MapPage, NationPage, RecordsPage } from './pages/WorldPages';
import { RankingPage } from './ranking/RankingPage';
import { parseRankingSearch } from './ranking/rankingView';
import { queryClient, trpc, type Trpc } from './trpc';
import { InspectionPage } from './operations/InspectionPage';
import { OperationDetailPage } from './operations/OperationDetailPage';
import { OperationsPage } from './operations/OperationsPage';
import { TurnsPage } from './turns/TurnsPage';
import { EmptyState, ErrorState } from './ui/States';

// 주소 체계: docs/plans/T1-13.md. 로그인 가드: docs/frontend-ui-guidelines.md §4.
interface RouterContext {
  queryClient: QueryClient;
  trpc: Trpc;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <main style={{ maxWidth: 480, margin: '64px auto' }}>
      <EmptyState title="없는 주소입니다" />
    </main>
  ),
});

// 화면 이동마다 서버에 세션을 다시 묻는다. 캐시만 보면 다른 탭에서 로그아웃했거나
// 세션이 만료된 뒤에도 이전 사용자로 통과한다 (T1-14 Codex 리뷰 1).
async function currentUser({ queryClient, trpc }: RouterContext) {
  const { user } = await queryClient.fetchQuery({ ...trpc.auth.me.queryOptions(), staleTime: 0 });
  return user;
}

function GuardError() {
  const router = useRouter();
  return (
    <main style={{ maxWidth: 480, margin: '64px auto' }}>
      <ErrorState title="서버에 연결할 수 없습니다" onRetry={() => void router.invalidate()} />
    </main>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    if (!(await currentUser(context))) throw redirect({ to: '/login' });
    // 로그인했으면 로비로 보낸다 (T2-04). 예전에는 첫 RUNNING 월드로 보냈다 (T1-16).
    throw redirect({ to: '/lobby', replace: true });
  },
  errorComponent: GuardError,
});

// 로비 (T2-04). 로그인하지 않아도 월드 목록을 본다. 참가 버튼만 로그인 여부로 바뀐다.
const lobbyRoute = createRoute({ getParentRoute: () => rootRoute, path: 'lobby', component: LobbyPage });

const authSearch = (search: Record<string, unknown>): { next?: string } =>
  typeof search.next === 'string' ? { next: search.next } : {};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: authSearch,
  component: LoginPage,
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'signup',
  validateSearch: authSearch,
  component: SignupPage,
});

// 계정 단위 알림 설정 (T2-21). 월드와 무관하고 로그인이 필요하다.
const notificationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings/notifications',
  beforeLoad: async ({ context, location }) => {
    if (!(await currentUser(context))) throw redirect({ to: '/login', search: { next: location.href } });
  },
  component: NotificationSettingsPage,
  errorComponent: GuardError,
});

// 게임 화면은 모두 로그인이 필요하다. 로그인 뒤 원래 주소로 돌아오도록 next에 담는다.
const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'w/$worldId',
  beforeLoad: async ({ context, location }) => {
    if (!(await currentUser(context))) throw redirect({ to: '/login', search: { next: location.href } });
  },
  component: GameLayout,
  errorComponent: GuardError,
});

// 메인 작업 화면. ?city는 지도에서 고른 도시다 (없으면 내 장수의 도시).
const mainSearch = (search: Record<string, unknown>): { city?: number } => {
  const city = Number(search.city);
  return Number.isInteger(city) && city > 0 && city <= 2_147_483_647 ? { city } : {};
};
const worldIndexRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: '/',
  validateSearch: mainSearch,
  component: MainPage,
});

// 아래 주소는 직접 접근·새로고침 호환용 보조 화면이다. 핵심 조작은 메인에서 한다 (소유자 UI 정정 2026-10-21).
const mapRoute = createRoute({ getParentRoute: () => worldRoute, path: 'map', component: MapPage });

const turnsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'turns',
  component: TurnsPage,
});

const cityRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'city/$cityKey',
  component: function CityRoute() {
    const { cityKey } = cityRoute.useParams();
    return <CityPage key={cityKey} cityKeyParam={cityKey} />;
  },
});

const nationRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'nation/$nationId',
  component: function NationRoute() {
    const { nationId } = nationRoute.useParams();
    return <NationPage key={nationId} nationIdParam={nationId} />;
  },
});

// 인사부와 국가 예턴 (T2-06). nation/:nationId보다 고정 경로가 먼저 맞는다.
const personnelRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'nation/personnel',
  component: PersonnelPage,
});
const nationTurnsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'nation/turns',
  component: NationTurnsPage,
});

const RECORD_TABS = ['general', 'nation', 'world'] as const;
type RecordTab = (typeof RECORD_TABS)[number];

const recordsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'records',
  validateSearch: (search: Record<string, unknown>): { tab: RecordTab } => ({
    tab: RECORD_TABS.includes(search.tab as RecordTab) ? (search.tab as RecordTab) : 'general',
  }),
  component: function RecordsRoute() {
    const { tab } = recordsRoute.useSearch();
    return <RecordsPage tab={tab} />;
  },
});

// 순위 (T2-23). 주소: /w/:worldId/ranking?tab=generals|nations&by=…
const rankingRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'ranking',
  validateSearch: parseRankingSearch,
  component: RankingPage,
});

// 전투 시뮬레이터 (T4-34). 사용자가 넣은 가정으로 교전 한 번을 Web Worker에서 계산하는 보조 화면이다.
const simulatorRoute = createRoute({ getParentRoute: () => worldRoute, path: 'simulator', component: BattleSimPage });

// 외교실 (T2-08). 주소: /w/:worldId/diplomacy?tab=incoming|outgoing|active|ended|broken|write|trust
const diplomacyRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'diplomacy',
  validateSearch: parseDiplomacySearch,
  component: function DiplomacyRoute() {
    const { tab } = diplomacyRoute.useSearch();
    return <DiplomacyPage tab={tab} />;
  },
});
// 메시지 전체 화면 (T2-10). 메인 오른쪽 메시지 패널과 같은 부품이다.
const messagesRoute = createRoute({ getParentRoute: () => worldRoute, path: 'messages', component: MessagesPage });

// 국가 작전판 (T2-12). 목록·만들기, 작전 타임라인, 감찰. nation/inspection은 nation/$nationId보다 먼저 맞는다(정적 경로 우선).
const operationsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'operations',
  component: OperationsPage,
});
const operationRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'operations/$operationId',
  component: function OperationRoute() {
    const { operationId } = operationRoute.useParams();
    return <OperationDetailPage key={operationId} operationId={operationId} />;
  },
});
const inspectionRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'nation/inspection',
  component: InspectionPage,
});

const createGeneralRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'create',
  component: CreateGeneralPage,
});

// 도움말 (T2-17). 플레이어 가이드 9개와 생성 명령 목록. 로그인 없이 연다.
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'help',
  component: () => <HelpPage doc="index" />,
});
const helpDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'help/$doc',
  component: function HelpDocRoute() {
    const { doc } = helpDocRoute.useParams();
    return <HelpPage doc={doc} />;
  },
});

const devUiRoute = createRoute({ getParentRoute: () => rootRoute, path: 'dev/ui', component: DevUiPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  lobbyRoute,
  loginRoute,
  signupRoute,
  notificationSettingsRoute,
  helpRoute,
  helpDocRoute,
  worldRoute.addChildren([
    worldIndexRoute,
    mapRoute,
    turnsRoute,
    cityRoute,
    nationRoute,
    personnelRoute,
    nationTurnsRoute,
    recordsRoute,
    rankingRoute,
    simulatorRoute,
    diplomacyRoute,
    messagesRoute,
    operationsRoute,
    operationRoute,
    inspectionRoute,
    createGeneralRoute,
  ]),
  ...(import.meta.env.DEV ? [devUiRoute] : []),
]);

export const router = createRouter({ routeTree, context: { queryClient, trpc } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
