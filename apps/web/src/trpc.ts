import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext, createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query';

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type Trpc = TRPCOptionsProxy<AppRouter>;

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
}

export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: '/trpc' })] });
}

// 화면(useTRPC)과 라우터 가드(beforeLoad)가 같은 캐시를 보도록 하나만 만든다.
export const queryClient = makeQueryClient();
export const trpcClient = makeTrpcClient();
export const trpc: Trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
