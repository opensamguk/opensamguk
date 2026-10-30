import { test as legalTest } from './legalFixture';
import { initializeIntegrationResources } from '../tools/integration-resources';

export interface OfferRuntime {
  origin: string;
  failed(): void;
}

// AC-INT-11: 기존 공개 dist·loopback API·자기 UUID DB와 실패 보존 수명을 그대로 쓴다.
export const test = legalTest.extend<Record<never, never>, { offerRuntime: OfferRuntime | undefined }>({
  offerRuntime: [
    async ({ legalStack }, use) => {
      try {
        await initializeIntegrationResources(legalStack.db);
        await use({ origin: legalStack.origin, failed: () => (legalStack.failed = true) });
      } catch (error) {
        legalStack.failed = true;
        throw error;
      }
    },
    { scope: 'worker' },
  ],
});
