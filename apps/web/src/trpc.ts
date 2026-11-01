import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext, createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export type Trpc = TRPCOptionsProxy<AppRouter>;

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
}

// context.skipBatch인 요청만 따로 보낸다. 묶인 요청은 안의 요청이 모두 취소돼야 끊기므로
// 화면과 상관없는 확인(운영 입구)이 다른 화면 요청의 취소를 막지 않게 한다.
export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.context.skipBatch === true,
        true: httpLink({ url: '/trpc' }),
        false: httpBatchLink({ url: '/trpc' }),
      }),
    ],
  });
}

// 화면(useTRPC)과 라우터 가드(beforeLoad)가 같은 캐시를 보도록 하나만 만든다.
export const queryClient = makeQueryClient();
export const trpcClient = makeTrpcClient();
export const trpc: Trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
