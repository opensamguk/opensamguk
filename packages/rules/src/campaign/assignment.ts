import type { RuleFeatureDefinition } from '../ruleRegistry';
import { followCampaignCommanders } from './movement';

// 원생성의 기능 목록으로 판을 고정한다. 기존 campaign-v1 월 해시는 그대로 재생한다.
export const campaignAssignmentFeature: RuleFeatureDefinition = {
  key: 'campaign-assignment-v2',
  requires: ['campaign-v1'],
  conflicts: [],
  checkOrigin({ data }) {
    if (data !== undefined) throw new Error('발령 동행 규칙에 별도 초기 자료를 넣을 수 없습니다.');
  },
  settleMonthly({ before, settled }) {
    return {
      replay: { ...settled, state: followCampaignCommanders(before.state, settled.state) },
      effects: null,
    };
  },
};
