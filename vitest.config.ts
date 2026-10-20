import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,tools}/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '**/*.integration.test.ts'],
  },
});
