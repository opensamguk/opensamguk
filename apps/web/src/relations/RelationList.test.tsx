// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { TRPCLink } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 장수 정보의 인물 관계 (AC-P2-20, INT-26 relations.list). 마지막 tRPC link만 바꿔 손 데이터를 돌려준다.
const wire = vi.hoisted(() => ({ handlers: new Map<string, () => unknown>() }));

vi.mock('../trpc', async (importOriginal) => {
  const { createTRPCClient } = await import('@trpc/client');
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        const handler = wire.handlers.get(op.path);
        void Promise.resolve()
          .then(() => {
            if (!handler) throw new Error(`처리기가 없습니다: ${op.path}`);
            return handler();
          })
          .then(
            (data) => {
              observer.next({ result: { data } });
              observer.complete();
            },
            (error: unknown) => observer.error(error as never),
          );
      });
  return { ...(await importOriginal<object>()), trpcClient: createTRPCClient<AppRouter>({ links: [link] }) };
});

const { TRPCProvider, trpcClient } = await import('../trpc');
const { RelationList } = await import('./RelationList');

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wire.handlers.clear();
});
afterEach(cleanup);

function renderList(generalId: number) {
  return render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpcClient} queryClient={client}>
        <RelationList worldId="w1" generalId={generalId} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

describe('인물 관계', () => {
  it('이 장수가 낀 관계만 괄호 뺀 이름과 원형 얼굴로 보인다. 얼굴은 world.map 장수 번호로 찾는다', async () => {
    wire.handlers.set('relations.list', () => ({
      enabled: true,
      items: [
        { a: { id: 1, name: '유비(劉備)' }, b: { id: 2, name: '관우(關羽)' }, kind: 'sworn' },
        { a: { id: 3, name: '조운' }, b: { id: 1, name: '유비(劉備)' }, kind: 'lord' },
        { a: { id: 2, name: '관우(關羽)' }, b: { id: 4, name: '관평' }, kind: 'kin' },
      ],
    }));
    wire.handlers.set('world.map', () => ({
      cities: [],
      nations: [],
      generals: [{ id: 2, name: '관우(關羽)', cityKey: 1, nationId: 1, portraitId: 10001, isHuman: false }],
    }));
    renderList(1);
    const region = await screen.findByRole('region', { name: '인물 관계' });
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['관우 · 결의', '조운 · 군신']);
    const faces = region.querySelectorAll('[data-variant="icon"]');
    // world.map이 오면 관우는 얼굴, 지도 목록에 없는 조운은 실루엣이다.
    await vi.waitFor(() => expect(faces[0]!.getAttribute('data-state')).toBe('image'));
    expect(faces[1]!.getAttribute('data-state')).toBe('fallback');
  });

  it('이 장수가 낀 관계가 없으면 칸을 그리지 않는다', async () => {
    wire.handlers.set('relations.list', () => ({ enabled: false, items: [] }));
    wire.handlers.set('world.map', () => ({ cities: [], nations: [], generals: [] }));
    const { container } = renderList(9);
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(container.textContent).toBe('');
  });
});
