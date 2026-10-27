import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git·Bash 자식과 DOM 환경이 한꺼번에 몰려 실제 외부 실행 검사가 시간 제한을 넘지 않게 한다.
    maxWorkers: process.platform === 'win32' ? 1 : 2,
    include: ['{apps,packages,tools}/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '**/*.integration.test.ts'],
  },
});
