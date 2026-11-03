import { z } from 'zod';
import type { RecordedInput } from '../replay';
import type { InputKindDefinition, RuleFeatureDefinition } from '../ruleRegistry';
import { decideGovernanceAction, governanceInputSchema } from './actions';
import { governanceQuantity, readGovernanceConfig } from './config';
import { settleGovernanceMonthly } from './monthly';
import { reconcileGovernance } from './reconcile';
import { initialGovernanceState } from './state';

export const governanceResultSchema = z.strictObject({
  action: z.enum([
    'throne.ascend',
    'throne.abdicate',
    'vassal.offer',
    'vassal.respond',
    'vassal.release',
    'vassal.renounce',
    'court.offer',
    'court.respond',
    'court.dismiss',
    'court.resign',
    'court.remit',
    'court.censure',
  ]),
  revision: governanceQuantity.min(1),
  tick: governanceQuantity,
  offerId: governanceQuantity.min(1).optional(),
  vassalId: governanceQuantity.min(1).optional(),
});
const rejection = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });

export function validateGovernanceRecord(input: RecordedInput): void {
  if (input.kind !== 'governance.act') throw new Error('황실 입력 종류를 확인하세요.');
  governanceQuantity.min(1).parse(input.sequence);
  governanceQuantity.parse(input.tick);
  if (input.status === 'REJECTED') {
    rejection.parse(input.result);
    return;
  }
  governanceQuantity.min(1).parse(input.generalId);
  const payload = governanceInputSchema.parse(input.payload),
    result = governanceResultSchema.parse(input.result);
  if (result.action !== payload.type || result.tick !== input.tick) throw new Error('황실 입력과 결과가 다릅니다.');
}

export const governanceFeature: RuleFeatureDefinition = {
  key: 'governance-v1',
  requires: ['city-resources-v1', 'personnel', 'treaty'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'governance')) throw new Error('황실은 새 원생성의 빈 황위에서 시작합니다.');
    readGovernanceConfig(data, { cities: Object.fromEntries(initial.cities.map((city) => [city.cityKey, city])) });
  },
  initReplayState(replay, { data }) {
    if (Object.hasOwn(replay.state, 'governance')) throw new Error('황실 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, governance: initialGovernanceState(data, replay.state) } };
  },
  checkArchive({ inputs }) {
    for (const input of inputs) if (input.kind === 'governance.act') validateGovernanceRecord(input);
  },
  afterAppliedInput(_before, after, input, context) {
    if (context?.route !== 'queued') return after;
    return { ...after, state: reconcileGovernance(after.state, input.tick!) };
  },
  settleMonthly({ settled, tick }) {
    const { state, ...effects } = settleGovernanceMonthly(settled.state, tick);
    return { replay: { ...settled, state }, effects };
  },
};

export const governanceInputKind: InputKindDefinition = {
  kind: 'governance.act',
  feature: 'governance-v1',
  route: 'queued',
  apply(replay, input) {
    validateGovernanceRecord(input);
    if (input.status === 'REJECTED') return replay;
    const actor = replay.state.generals[input.generalId!];
    if (!actor?.userId) throw new Error('황실 입력의 사람 장수가 없습니다.');
    const outcome = decideGovernanceAction(replay.state, actor.id, input.payload, input.tick!);
    if (
      !outcome.ok ||
      JSON.stringify(governanceResultSchema.parse(outcome.result)) !==
        JSON.stringify(governanceResultSchema.parse(input.result))
    )
      throw new Error('황실 입력을 재현하지 못했습니다.');
    return { ...replay, state: outcome.state };
  },
};
