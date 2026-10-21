import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { resolveApiTarget } from './apiTarget';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const apiTarget = resolveApiTarget(process.env, loadEnv(mode, repoRoot, ''));
  return {
    plugins: [react()],
    // 환경변수는 루트 .env 하나로 모은다. 화면에는 VITE_로 시작하는 공개값만 들어간다.
    envDir: repoRoot,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/trpc': apiTarget,
      },
    },
  };
});
