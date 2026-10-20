import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/tokens.css';
import './styles/global.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './router';
import { makeQueryClient, makeTrpcClient, TRPCProvider } from './trpc';

const queryClient = makeQueryClient();
const trpcClient = makeTrpcClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root가 없습니다');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>,
);
