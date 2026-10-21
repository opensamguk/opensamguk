import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'pending-review.spec.ts',
  workers: 1,
  use: { ...base.use, trace: 'retain-on-failure' },
});
