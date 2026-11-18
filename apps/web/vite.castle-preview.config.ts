// 성 화면 미리보기 아티팩트 묶음(사용자 2026-11-17 "아티팩트에 반영해."). 게임 빌드와 따로 돈다.
// CASTLE_PREVIEW_OUT=<폴더> npx vite build --config vite.castle-preview.config.ts
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [{ find: '@opensamguk/shared/public-images', replacement: here('./src/stage/preview/publicImagesShim.ts') }],
  },
  build: {
    outDir: process.env.CASTLE_PREVIEW_OUT ?? 'dist-castle-preview',
    emptyOutDir: false,
    rollupOptions: { input: here('./castle-preview.html'), output: { inlineDynamicImports: true } },
  },
});
