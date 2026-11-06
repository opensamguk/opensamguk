import { rngFor } from '@opensamguk/shared';
import type { RuleFeatureDefinition } from '../ruleRegistry';
import { monthlyDate } from '../monthly';
import { REPUTATION_FEATURE } from './schema';
import { appendMonthlyReview, appendReputationEvents } from './ledger';
import { buildMonthlyReview } from './settle';
import { reputationInputEvents } from './events';

export const reputationFeature: RuleFeatureDefinition = {
  key: REPUTATION_FEATURE,
  requires: [],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (data !== undefined || Object.hasOwn(initial, 'reputation'))
      throw Error('월단평은 별도 초기 자료 없이 빈 원장으로 시작합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay, 'reputation')) throw Error('평판 초기화가 중복됐습니다.');
    return { ...replay, reputation: { events: [], reviews: [] } };
  },
  afterAppliedInput(before, after, input) {
    if (!after.reputation) throw Error('월단평 재생 원장이 없습니다.');
    return {
      ...after,
      reputation: appendReputationEvents(after.reputation, reputationInputEvents({ before: before.state, input })),
    };
  },
  settleMonthly({ settled, tick, seed }) {
    if (!settled.reputation || seed === undefined) throw Error('월단평 원장이나 시드가 없습니다.');
    const date = monthlyDate(settled.state.startYear, tick);
    const review = buildMonthlyReview(
      settled.reputation.events,
      { ...date, tick },
      rngFor(seed, 'review', date.year, date.month),
    );
    return { replay: { ...settled, reputation: appendMonthlyReview(settled.reputation, review) }, effects: { review } };
  },
};
