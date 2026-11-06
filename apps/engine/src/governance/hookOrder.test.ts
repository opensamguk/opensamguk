import { expect, it } from 'vitest';
import { ruleRegistry } from '@opensamguk/rules';
import { engineFeatures } from '../features';

it('AC-P2-31 queued 후처리가 재생과 같은 순서이며 기존 캠페인·인사 순서를 유지한다', () => {
  const remaining = ruleRegistry.features
    .filter((feature) => feature.afterAppliedInput)
    .map((feature) => feature.key)
    .filter((key) => key !== 'stratagem-cards-v1')
    .sort();
  const replay = ['stratagem-cards-v1', ...remaining];
  const engine = engineFeatures.filter((feature) => feature.afterQueuedInput).map((feature) => feature.key);
  expect(engine).toEqual(replay);
  expect(engine.filter((key) => !['stratagem-cards-v1', 'governance-v1', 'lineage-v1'].includes(key))).toEqual([
    'campaign-v1',
    'personnel',
    'reputation-v1',
  ]);
  expect(ruleRegistry.monthlyOrder!.indexOf('lineage-v1')).toBeLessThan(
    ruleRegistry.monthlyOrder!.indexOf('personnel'),
  );
});
