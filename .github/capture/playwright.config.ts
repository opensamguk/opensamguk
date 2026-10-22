import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'observe.spec.ts', timeout: 300000, use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1600, height: 1100 }, locale: 'ko-KR', trace: 'retain-on-failure' } });
