import { expect, it } from 'vitest';
import { ruleRegistry } from '@opensamguk/rules';
import { engineFeatures } from '../features';

it('AC-P2-31 queued 후처리가 재생과 같은 순서이며 기존 캠페인·인사 순서를 유지한다', () => {
  const replay = ruleRegistry.features
    .filter((feature) => feature.afterAppliedInput)
    .map((feature) => feature.key)
    .sort();
  const engine = engineFeatures.filter((feature) => feature.afterQueuedInput).map((feature) => feature.key);
  expect(engine).toEqual(replay);
  expect(engine.filter((key) => key !== 'governance-v1')).toEqual(['campaign-v1', 'personnel']);
});
