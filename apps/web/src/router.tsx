import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { GameLayout } from './layout/GameLayout';
import { DevUiPage } from './pages/DevUiPage';
import { LoginPage } from './pages/LoginPage';
import { MainPage } from './pages/MainPage';
import { Placeholder } from './pages/Placeholder';
import { SignupPage } from './pages/SignupPage';
import { EmptyState } from './ui/States';

// 주소 체계: docs/plans/T1-13.md. 로그인 가드는 T1-14에서 auth.me로 붙인다.
const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main style={{ maxWidth: 480, margin: '64px auto' }}>
      <EmptyState title="없는 주소입니다" />
    </main>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/login' });
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: 'login', component: LoginPage });
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: 'signup', component: SignupPage });

const worldRoute = createRoute({ getParentRoute: () => rootRoute, path: 'w/$worldId', component: GameLayout });

const worldIndexRoute = createRoute({ getParentRoute: () => worldRoute, path: '/', component: MainPage });

const mapRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'map',
  component: () => <Placeholder title="지도" task="T1-16" />,
});

const turnsRoute = createRoute({
  getParentRoute: () => worldRoute,
  path: 'turns',
  component: () => <Placeholder title="예턴 편집" task="T1-15" />,
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
  component: () => <Placeholder title="장수 생성" task="T1-15" />,
});

const devUiRoute = createRoute({ getParentRoute: () => rootRoute, path: 'dev/ui', component: DevUiPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  worldRoute.addChildren([worldIndexRoute, mapRoute, turnsRoute, cityRoute, nationRoute, recordsRoute, createGeneralRoute]),
  ...(import.meta.env.DEV ? [devUiRoute] : []),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
