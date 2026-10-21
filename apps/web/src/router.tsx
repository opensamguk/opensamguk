import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouter,
} from '@tanstack/react-router';
import { CreateGeneralPage } from './general/CreateGeneralPage';
import { GameLayout } from './layout/GameLayout';
import { DevUiPage } from './pages/DevUiPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { MainPage } from './pages/MainPage';
import { Placeholder } from './pages/Placeholder';
import { SignupPage } from './pages/SignupPage';
import { queryClient, trpc, type Trpc } from './trpc';
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
  },
  component: HomePage,
  errorComponent: GuardError,
});

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

const worldIndexRoute = createRoute({ getParentRoute: () => worldRoute, path: '/', component: MainPage });

const mapRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'map',
  component: () => <Placeholder title="지도" task="T1-16" />,
});

const turnsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'turns',
  component: TurnsPage,
});

const cityRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'city/$cityKey',
  component: function CityPage() {
    const { cityKey } = cityRoute.useParams();
    return <Placeholder title={`도시 정보 · ${cityKey}`} task="T1-16" />;
  },
});

const nationRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'nation/$nationId',
  component: function NationPage() {
    const { nationId } = nationRoute.useParams();
    return <Placeholder title={`국가 정보 · ${nationId}`} task="T1-16" />;
  },
});

const RECORD_TABS = ['general', 'nation', 'world'] as const;
type RecordTab = (typeof RECORD_TABS)[number];

const recordsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'records',
  validateSearch: (search: Record<string, unknown>): { tab: RecordTab } => ({
    tab: RECORD_TABS.includes(search.tab as RecordTab) ? (search.tab as RecordTab) : 'general',
  }),
  component: function RecordsPage() {
    const { tab } = recordsRoute.useSearch();
    const label = { general: '내 장수', nation: '국가 역사', world: '월드 정세' }[tab];
    return <Placeholder title={`기록 · ${label}`} task="T1-16" />;
  },
});

const createGeneralRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'create',
  component: CreateGeneralPage,
});

const devUiRoute = createRoute({ getParentRoute: () => rootRoute, path: 'dev/ui', component: DevUiPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  worldRoute.addChildren([
    worldIndexRoute,
    mapRoute,
    turnsRoute,
    cityRoute,
    nationRoute,
    recordsRoute,
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
