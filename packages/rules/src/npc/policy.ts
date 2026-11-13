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
} as const;
const bounded = ({ min, max }: { min: number; max: number }) => z.number().int().min(min).max(max);
export const npcNationPolicySchema = z.strictObject({
  recruitTarget: bounded(npcPolicyLimits.recruitTarget),
  trainingTarget: bounded(npcPolicyLimits.trainingTarget),
  moraleTarget: bounded(npcPolicyLimits.moraleTarget),
  rewardGoldTarget: bounded(npcPolicyLimits.rewardGoldTarget),
});
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
): NpcNationPolicy {
  return (view.ruleFeatures?.includes(NPC_NATION_POLICY_FEATURE) && nation?.npcSettings) || NPC_DEFAULT_POLICY;
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
    Object.keys(policy).some(
      (key) => policy[key as keyof NpcNationPolicy] !== result.policy[key as keyof NpcNationPolicy],
    )
  )
    throw new Error('NPC 운영 기준 기록이 올바르지 않습니다.');
  const next = structuredClone(replay);
  next.state.nations[nationId]!.npcSettings = policy;
  return next;
}
