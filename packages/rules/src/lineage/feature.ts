import { z } from 'zod';
import type { RecordedInput } from '../replay';
import type { InputKindDefinition, RuleFeatureDefinition } from '../ruleRegistry';
import { toWorldState } from '../model/world';
import { emptyQueue } from '../policy';
import { emptyTurns } from '../replayInputs';
import { decideLineageAction, lineageInputSchema } from './actions';
import { lineageId, lineageQuantity } from './config';
import { recordedLineageSuccession, resetLineageControl } from './control';
import { settleLineageMonthly } from './monthly';
import { reconcileLineage } from './reconcile';
import { initialLineageState } from './state';

export const lineageResultSchema = z.strictObject({
  action: z.enum(['marriage.propose', 'marriage.respond', 'heir.designate', 'succession.confirm', 'ruler.claim']),
  revision: lineageId,
  tick: lineageQuantity,
  offerId: lineageId.optional(),
  marriageId: lineageId.optional(),
  householdGeneralId: lineageId.optional(),
  successorId: lineageId.optional(),
  nationId: lineageId.optional(),
});
export const lineageRejectionSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export function validateLineageRecord(input: RecordedInput): void {
  if (input.kind !== 'lineage.act') throw Error('가문 입력 종류를 확인하세요.');
  lineageId.parse(input.sequence);
  lineageQuantity.parse(input.tick);
  if (input.status === 'REJECTED') {
    lineageRejectionSchema.parse(input.result);
    return;
  }
  lineageId.parse(input.generalId);
  const payload = lineageInputSchema.parse(input.payload),
    result = lineageResultSchema.parse(input.result);
  if (result.action !== payload.type || result.tick !== input.tick) throw Error('가문 입력과 결과가 다릅니다.');
}

export const lineageFeature: RuleFeatureDefinition = {
  key: 'lineage-v1',
  requires: ['personnel'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'lineage')) throw Error('가문은 원생성의 빈 관계에서 시작합니다.');
    initialLineageState(data, toWorldState(initial), initial.seed);
  },
  initReplayState(replay, { initial, data }) {
    if (Object.hasOwn(replay.state, 'lineage')) throw Error('가문 초기화가 중복됐습니다.');
    return {
      ...replay,
      state: { ...replay.state, lineage: initialLineageState(data, replay.state, initial.seed) },
      lineageResources: {
        statRules: structuredClone(initial.statRules),
        unitSet: { defaultCrewTypeId: initial.unitSet.defaultCrewTypeId },
      },
    };
  },
  checkArchive({ inputs }) {
    for (const input of inputs) if (input.kind === 'lineage.act') validateLineageRecord(input);
  },
  afterAppliedInput(_before, after, input, context) {
    if (context?.route !== 'queued') return after;
    return { ...after, state: reconcileLineage(after.state, input.tick!) };
  },
  settleMonthly({ settled, tick }) {
    if (!settled.lineageResources) throw Error('가문 재생의 원생성 자료가 없습니다.');
    const { state, effects } = settleLineageMonthly(settled.state, tick, settled.lineageResources);
    let replay = { ...settled, state };
    for (const death of effects.deaths)
      if (death.successorId !== null)
        replay = resetLineageControl(settled, replay, death.generalId, death.successorId, 'NPC_DEATH', tick);
    for (const { generalId } of effects.births) {
      replay.turns = { ...replay.turns, [generalId]: replay.policy ? emptyQueue() : emptyTurns() };
      replay.revisions = { ...replay.revisions, [generalId]: 0 };
      if (replay.policy)
        replay.policy = { ...replay.policy, policies: { ...replay.policy.policies, [generalId]: 'none' } };
    }
    return { replay, effects };
  },
};

export const lineageInputKind: InputKindDefinition = {
  kind: 'lineage.act',
  feature: 'lineage-v1',
  route: 'queued',
  apply(replay, input) {
    validateLineageRecord(input);
    if (input.status === 'REJECTED') return replay;
    if (!replay.state.generals[input.generalId!]?.userId) throw Error('가문 입력의 사람 장수가 없습니다.');
    const outcome = decideLineageAction(replay.state, input.generalId!, input.payload, input.tick!);
    if (
      !outcome.ok ||
      JSON.stringify(lineageResultSchema.parse(outcome.result)) !==
        JSON.stringify(lineageResultSchema.parse(input.result))
    )
      throw Error('가문 입력을 재현하지 못했습니다.');
    const next = { ...replay, state: outcome.world },
      succession = recordedLineageSuccession(input);
    return succession
      ? resetLineageControl(replay, next, succession.fromId, succession.toId, 'HUMAN', input.tick!)
      : next;
  },
};
