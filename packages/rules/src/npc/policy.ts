import { z } from 'zod';
import type { RecordedInput, ReplayState } from '../replay';
import type { DeepReadonly, WorldView } from '../model/world';
import type { InitialNation } from '../world/bootstrap';
import { BALANCE } from '../balance';

export const NPC_NATION_POLICY_FEATURE = 'npc-nation-policy-v1';
export const NPC_NATION_POLICY_KIND = 'nation.setNpcPolicy';
export const npcPolicyLimits = {
  recruitTarget: { min: 0, max: 100_000 },
  trainingTarget: { min: 20, max: 100 },
  moraleTarget: { min: 20, max: 100 },
  rewardGoldTarget: { min: 0, max: 1_000_000 },
  minRecruitPopulation: { min: 0, max: 1_000_000 },
  safeRecruitPopulationPercent: { min: 0, max: 100 },
  reserveGold: { min: 0, max: 1_000_000 },
  minReward: { min: 0, max: 1_000_000 },
  maxReward: { min: 1, max: 1_000_000 },
  minWarCrew: { min: 0, max: 100_000 },
  minNpcWarLeadership: { min: 0, max: 200 },
  cureThreshold: { min: 0, max: 100 },
} as const;
const bounded = ({ min, max }: { min: number; max: number }) => z.number().int().min(min).max(max);
export const npcGeneralCommands = [
  'join',
  'return',
  'move',
  'farm',
  'commerce',
  'security',
  'settle',
  'goodwill',
  'defence',
  'wall',
  'research',
  'form_unit',
  'recruit',
  'train',
  'morale',
  'trade_rice',
  'attack',
  'heal',
] as const;
export const npcNationCommands = [
  'nation_capital',
  'nation_declare',
  'nation_reward',
  'nation_city_allocate',
  'nation_mobilize',
  'nation_rivalry',
  'nation_raid',
] as const;
const priority = <T extends [string, ...string[]]>(keys: readonly [...T]) =>
  z
    .array(z.enum(keys))
    .max(keys.length)
    .refine((items) => new Set(items).size === items.length);

export const npcNationPolicySchema = z
  .strictObject({
    recruitTarget: bounded(npcPolicyLimits.recruitTarget),
    trainingTarget: bounded(npcPolicyLimits.trainingTarget),
    moraleTarget: bounded(npcPolicyLimits.moraleTarget),
    rewardGoldTarget: bounded(npcPolicyLimits.rewardGoldTarget),
    minRecruitPopulation: bounded(npcPolicyLimits.minRecruitPopulation).optional(),
    safeRecruitPopulationPercent: bounded(npcPolicyLimits.safeRecruitPopulationPercent).optional(),
    reserveGold: bounded(npcPolicyLimits.reserveGold).optional(),
    minReward: bounded(npcPolicyLimits.minReward).optional(),
    maxReward: bounded(npcPolicyLimits.maxReward).optional(),
    minWarCrew: bounded(npcPolicyLimits.minWarCrew).optional(),
    minNpcWarLeadership: bounded(npcPolicyLimits.minNpcWarLeadership).optional(),
    cureThreshold: bounded(npcPolicyLimits.cureThreshold).optional(),
    generalPriority: priority(npcGeneralCommands).optional(),
    nationPriority: priority(npcNationCommands).optional(),
  })
  .refine(
    (policy) =>
      policy.minReward === undefined || policy.maxReward === undefined || policy.minReward <= policy.maxReward,
    '최소 포상 금액은 최대 포상 금액 이하여야 합니다.',
  );
export type NpcNationPolicy = z.infer<typeof npcNationPolicySchema>;

export const NPC_DEFAULT_POLICY = {
  recruitTarget: 2000,
  trainingTarget: 60,
  moraleTarget: 70,
  rewardGoldTarget: 10000,
} as const satisfies NpcNationPolicy;

export const npcNationPolicyInput = z.strictObject({
  nationId: z.number().int().min(1).max(2_147_483_647),
  policy: npcNationPolicySchema,
});

export function storedNpcNationPolicy(enabled: boolean, raw: unknown) {
  if (raw == null) return {};
  if (!enabled) throw new Error('NPC 운영 기준을 끈 월드에 저장된 정책이 있습니다.');
  return { npcSettings: npcNationPolicySchema.parse(raw) };
}

export function npcNationPolicy(
  view: Pick<WorldView, 'ruleFeatures'>,
  nation: DeepReadonly<Pick<InitialNation, 'npcSettings'>> | undefined,
): DeepReadonly<NpcNationPolicy> {
  return (view.ruleFeatures?.includes(NPC_NATION_POLICY_FEATURE) && nation?.npcSettings) || NPC_DEFAULT_POLICY;
}

export function npcRecruitPopulation(
  policy: Pick<NpcNationPolicy, 'minRecruitPopulation' | 'safeRecruitPopulationPercent'>,
  city: { population: number; populationMax: number },
) {
  return (
    city.population >= (policy.minRecruitPopulation ?? 0) &&
    city.population * 100 >= city.populationMax * (policy.safeRecruitPopulationPercent ?? 0)
  );
}

export function applyNpcNationPolicy(replay: ReplayState, input: RecordedInput): ReplayState {
  const { nationId, policy } = npcNationPolicyInput.parse(input.payload);
  const result = npcNationPolicyInput.parse(input.result);
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (
    !actor ||
    actor.userId === null ||
    actor.removedAt !== undefined ||
    actor.nationId !== nationId ||
    actor.officerLevel !== BALANCE.RULER_LEVEL ||
    !replay.state.nations[nationId] ||
    result.nationId !== nationId ||
    JSON.stringify(policy) !== JSON.stringify(result.policy)
  )
    throw new Error('NPC 운영 기준 기록이 올바르지 않습니다.');
  const next = structuredClone(replay);
  next.state.nations[nationId]!.npcSettings = policy;
  return next;
}
