// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Home, WorldSummary } from '../game/types';
import { displayedAge, GeneralInfo } from './GeneralInfo';

// 장수 정보 칸의 나이가 lineage-v1 월드에서 가문 칸과 같은 연도 기준인지 본다 (T4-95, AC-P2-32).
// 해가 바뀐 1월에는 저장 나이가 월말 정산 전이라 한 살 적다. 인물·수치는 시험 값이다.
const mocks = vi.hoisted(() => ({ summary: undefined as unknown }));
vi.mock('../trpc', () => ({
  useTRPC: () => ({
    world: { summary: { queryOptions: () => ({ queryKey: ['summary'], queryFn: async () => mocks.summary }) } },
  }),
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../lineage/LineagePanel', () => ({ LineagePanel: () => null }));
vi.mock('../portrait/Portrait', () => ({ Portrait: () => null }));

afterEach(cleanup);

const summary = (year: number, month: number, lineage: boolean) =>
  ({
    status: 'RUNNING',
    startYear: 190,
    gameDate: { year, month },
    ...(lineage ? { lineageEnabled: true } : {}),
  }) as unknown as WorldSummary;
// 191년에 태어난 자녀. 저장 나이는 아직 191년 값(0)이다.
const heir = { age: 0, birthYear: 191 };

describe('displayedAge', () => {
  it('lineage 월드는 192년 1월에 현재 연도 - 출생 연도(1세)를 보인다', () => {
    expect(displayedAge(heir, summary(192, 1, true))).toBe(1);
  });

  it('해가 바뀌기 전(191년 12월)에는 저장 나이와 같다', () => {
    expect(displayedAge(heir, summary(191, 12, true))).toBe(0);
  });

  it('기능이 꺼진 월드는 저장 나이를 그대로 쓴다', () => {
    expect(displayedAge(heir, summary(192, 1, false))).toBe(0);
    expect(displayedAge({ age: 37, birthYear: 150 }, summary(192, 1, false))).toBe(37);
  });

  it('요약을 아직 받지 못했으면 저장 나이를 쓴다', () => {
    expect(displayedAge(heir, undefined)).toBe(0);
  });
});

const home = {
  general: {
    id: 11,
    name: '후계',
    nationId: null,
    portraitId: null,
    cityKey: 7,
    leadership: 50,
    strength: 50,
    intel: 50,
    officerLevel: 0,
    injury: 0,
    gold: 0,
    rice: 0,
    crew: 0,
    train: 0,
    atmos: 0,
    experience: 0,
    dedication: 0,
    policy: { key: 'none', name: '없음' },
    ...heir,
  },
  nextTurnAt: null,
} as unknown as Home;

function ageCell() {
  return screen.getByText('나이').nextElementSibling?.textContent;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GeneralInfo worldId="world-one" home={home} cityName="낙양" nation={undefined} onSelectCity={() => {}} />
    </QueryClientProvider>,
  );
  return client;
}

describe('장수 정보 칸 나이', () => {
  it('lineage 월드 192년 1월에는 가문 칸과 같은 1세를 보인다', async () => {
    mocks.summary = summary(192, 1, true);
    renderCard();
    await waitFor(() => expect(ageCell()).toBe('1세'));
  });

  it('기능이 꺼진 월드는 저장 나이 0세를 그대로 보인다', async () => {
    mocks.summary = summary(192, 1, false);
    const client = renderCard();
    // 요약이 온 뒤에도 바뀌지 않는다.
    await waitFor(() => expect(client.getQueryData(['summary'])).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ageCell()).toBe('0세');
  });
});
