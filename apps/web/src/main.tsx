import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
// 화면 글꼴 시험(사용자 2026-11-15 "폰트를 Noto Serif로 가는게 좋을거 같은데"). 명령 패와 세부 메뉴는 Codex 글자 그림을 그대로 쓴다.
import '@fontsource-variable/noto-serif-kr/index.css';
import '@fontsource/dotgothic16/400.css';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/kit.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './router';
import { installKit } from './ui/kit';
import { queryClient, TRPCProvider, trpcClient } from './trpc';

const root = document.getElementById('root');
if (!root) throw new Error('#root가 없습니다');

// 쇼케이스 UI 키트 그림 주소를 CSS 변수로 올린다(styles/kit.css가 쓴다).
installKit();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>,
);
