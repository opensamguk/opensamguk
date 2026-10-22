import { defineConfig } from '@playwright/test';
import root from '../playwright.config';
export default defineConfig({
  ...root,
  testDir: '../e2e',
  testMatch: 'battleSim.review.spec.ts',
  outputDir: '../review-output/production',
  webServer: {
    command: 'python3 review-t434/serve.py',
    cwd: process.cwd(),
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
