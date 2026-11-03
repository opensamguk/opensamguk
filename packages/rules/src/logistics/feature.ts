import { z } from 'zod';
import type { InputKindDefinition, RuleFeatureDefinition } from '../ruleRegistry';
import type { RecordedInput } from '../replay';
import { logisticsMovementSchema } from './ledger';
import { applyLogisticsInput, logisticsInputSchema, settleLogisticsMonthly } from './operations';
import { settleNpcLogistics } from './npc';
import { initialLogisticsState, logisticsQuantity, readLogisticsConfig } from './state';

export const logisticsResultSchema = z.strictObject({
  action: z.enum(['dispatch', 'cancel', 'upgrade', 'trade']),
  revision: logisticsQuantity.min(1),
  tick: logisticsQuantity,
  convoyId: logisticsQuantity.min(1).optional(),
  arriveTick: logisticsQuantity.min(1).optional(),
  path: z.array(logisticsQuantity.min(1)).optional(),
  movements: z.array(logisticsMovementSchema),
});
const rejection = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });

export function validateLogisticsRecord(input: RecordedInput): void {
  if (input.kind !== 'logistics.order') throw new Error('물류 입력 종류를 확인하세요.');
  logisticsQuantity.min(1).parse(input.sequence);
  logisticsQuantity.parse(input.tick);
  if (input.status === 'REJECTED') {
    rejection.parse(input.result);
    return;
  }
  logisticsQuantity.min(1).parse(input.generalId);
  const payload = logisticsInputSchema.parse(input.payload),
    result = logisticsResultSchema.parse(input.result);
  if (result.tick !== input.tick || result.action !== payload.type)
    throw new Error('물류 입력과 처리 결과가 다릅니다.');
}

export const logisticsFeature: RuleFeatureDefinition = {
  key: 'logistics-v1',
  requires: ['city-resources-v1'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'logistics')) throw new Error('물류는 새 판의 빈 재고에서 시작합니다.');
    const config = readLogisticsConfig(data, {
      cities: Object.fromEntries(initial.cities.map((city) => [city.cityKey, city])),
    });
    const armTypes = new Set(initial.unitSet.crewTypes.filter((row) => row.armType > 0).map((row) => row.armType));
    if ('npc' in config && armTypes.size === 0) throw new Error('NPC 물류에는 군사 병종이 필요합니다.');
    if (
      Object.keys(config.recruitPer100).length !== armTypes.size ||
      Object.keys(config.recruitPer100).some((key) => !armTypes.has(Number(key)))
    )
      throw new Error('물류 모병 비용은 원생성의 모든 군사 병과에 명시해야 합니다.');
  },
  initReplayState(replay, { data }) {
    if (Object.hasOwn(replay.state, 'logistics')) throw new Error('물류 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, logistics: initialLogisticsState(data, replay.state) } };
  },
  checkArchive({ inputs }) {
    for (const input of inputs) if (input.kind === 'logistics.order') validateLogisticsRecord(input);
  },
  settleMonthly({ settled, tick }) {
    const result = settleLogisticsMonthly(settled.state, tick);
    const npc = settleNpcLogistics(result.state, tick, settled.campaignUnitSet);
    return {
      replay: { ...settled, state: npc.state },
      effects: { movements: [...result.movements, ...npc.movements] },
    };
  },
};

export const logisticsInputKind: InputKindDefinition = {
  kind: 'logistics.order',
  feature: 'logistics-v1',
  route: 'queued',
  apply(replay, input) {
    validateLogisticsRecord(input);
    if (input.status === 'REJECTED') return replay;
    const actor = replay.state.generals[input.generalId!];
    if (!actor?.userId) throw new Error('물류 입력의 사람 장수가 없습니다.');
    const outcome = applyLogisticsInput(replay.state, input.payload, actor.id, {
      tick: input.tick!,
      userId: actor.userId,
      userActive: true,
    });
    if (
      !outcome.ok ||
      JSON.stringify(logisticsResultSchema.parse(outcome.result)) !==
        JSON.stringify(logisticsResultSchema.parse(input.result))
    )
      throw new Error('물류 기록을 재현하지 못했습니다.');
    return { ...replay, state: outcome.state };
  },
};
