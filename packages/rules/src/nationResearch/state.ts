import { z } from 'zod';
import type { WorldView } from '../model/world';
import { crewResearchNames } from '../world/resources';

export const NATION_RESEARCH_FEATURE = 'nation-research-v1';
export const nationResearchSchema = z.strictObject({
  version: z.literal(1),
  nations: z.record(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((key) => Number.isSafeInteger(Number(key))),
    z
      .array(crewResearchNames)
      .refine(
        (names) =>
          new Set(names).size === names.length && names.every((name, index) => index === 0 || names[index - 1]! < name),
      ),
  ),
});
export type ResearchName = z.infer<typeof crewResearchNames>;
export type NationResearchState = z.infer<typeof nationResearchSchema>;
export const initialNationResearch = (): NationResearchState => ({ version: 1, nations: {} });
export function readNationResearch(value: unknown, world: Pick<WorldView, 'ruleFeatures'>) {
  if (!world.ruleFeatures?.includes(NATION_RESEARCH_FEATURE)) {
    if (value != null) throw new Error('연구 기능을 끈 월드에 완료 기록이 있습니다.');
    return undefined;
  }
  return nationResearchSchema.parse(value);
}
