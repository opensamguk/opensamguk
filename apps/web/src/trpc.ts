import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
}

export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: '/trpc' })] });
}
