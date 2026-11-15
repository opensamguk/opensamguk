import { initialReplayState } from '../replay';
import { commandInitial } from '../../test/commandFixture';
import { describe, expect, it } from 'vitest';
import {
  applyProposalRecord,
  canApproveProposal,
  invalidatedProposalProposers,
  proposalExpired,
  PROPOSAL_DEDICATION,
} from './proposals';
import { personnelWorld } from './testFixture';
import type { RecordedInput, ReplayState } from '../replay';
import { applyRecordedInput } from '../replay';

describe('AC-M1-14 국가 명령 상신 규칙', () => {
  it('일반 장수·수뇌·참모·군주의 권한과 연구 기능을 구분한다', () => {
    expect(canApproveProposal({}, 1, 'nation_reward')).toBe(false);
    expect(canApproveProposal({}, 5, 'nation_reward')).toBe(true);
    expect(canApproveProposal({}, 5, 'nation_declare')).toBe(false);
    expect(canApproveProposal({}, 11, 'nation_pact')).toBe(true);
    expect(canApproveProposal({}, 12, 'nation_declare')).toBe(true);
    expect(canApproveProposal({}, 12, 'nation_research_greatsword')).toBe(true);
    expect(canApproveProposal({}, 5, 'nation_research_greatsword')).toBe(true);
  });
  it('12턴 경계·이탈·직위 변경·제거로 종료한다', () => {
    const proposal = { nationId: 1, proposerLevel: 1, expiresTick: 112 };
    const actor = { nationId: 1, officerLevel: 1, removedAt: null };
    expect(proposalExpired(proposal, actor, 111)).toBe(false);
    expect(proposalExpired(proposal, actor, 112)).toBe(true);
    expect(proposalExpired(proposal, { ...actor, nationId: 2 }, 100)).toBe(true);
    expect(proposalExpired(proposal, { ...actor, officerLevel: 5 }, 100)).toBe(true);
    expect(proposalExpired(proposal, { ...actor, removedAt: 'removed' }, 100)).toBe(true);
    expect(proposalExpired(proposal, undefined, 100)).toBe(true);
  });
  it('승인 공헌을 불변 사본에 재생하고 변조한 지급을 거부한다', () => {
    const replay: ReplayState = { ...initialReplayState(commandInitial()), state: personnelWorld() };
    const old = replay.state.generals[3]!.dedication;
    const input: RecordedInput = {
      kind: 'proposal.record',
      generalId: null,
      sequence: 1,
      tick: 100,
      status: 'APPLIED',
      payload: {
        proposalId: '10000000-0000-4000-8000-000000000001',
        proposerId: 3,
        nationId: 1,
        action: 'approve',
        text: '승인',
      },
      result: { dedication: PROPOSAL_DEDICATION },
    };
    expect(applyProposalRecord(replay, input).state.generals[3]!.dedication).toBe(old + PROPOSAL_DEDICATION);
    expect(applyRecordedInput(replay, input).state.generals[3]!.dedication).toBe(old + PROPOSAL_DEDICATION);
    expect(replay.state.generals[3]!.dedication).toBe(old);
    expect(() => applyProposalRecord(replay, { ...input, result: { dedication: 999 } })).toThrow();
    expect(
      applyProposalRecord(replay, {
        ...input,
        payload: { ...(input.payload as object), action: 'reject' },
        result: { dedication: 0 },
      }),
    ).toBe(replay);
  });
  it('소속이나 직위가 바뀌었다 돌아와도 닫을 제안자를 전환 시점에 고른다', () => {
    const before = personnelWorld();
    const next = structuredClone(before);
    expect(invalidatedProposalProposers(before, next)).toEqual([]);
    next.generals[3]!.nationId = 2;
    next.generals[4]!.officerLevel = 1;
    expect(invalidatedProposalProposers(before, next)).toEqual([3, 4]);
  });
});
