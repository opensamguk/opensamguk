import { readFile } from 'node:fs/promises';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { PublishedResource } from '@opensamguk/db';
import {
  checkRuleFeatures,
  parsePreset,
  ruleRegistry,
  scenarioSchema,
  statRulesSchema,
  type RuleRegistry,
} from '@opensamguk/rules';
import { operationalMapSchema, validateWorldResources } from '@opensamguk/rules/resource-validation';
import { hashState } from '@opensamguk/shared/node';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

export const creationOptionsInput = z.strictObject({ expectedUserId: z.uuid() });
export const creationFeatures = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
] as const;
export const creationSelection = {
  scenarioKey: 'integration191',
  mapKey: 'integration',
  unitSetKey: 'basic',
  statRulesKey: 'five-stats',
  portraitMapKey: '191-map',
} as const;
export const creationRefs = [
  { kind: 'MAP', name: 'integration', version: 1 },
  { kind: 'SCENARIO', name: 'integration191', version: 1 },
  { kind: 'UNIT_SET', name: 'basic', version: 1 },
  { kind: 'STAT_RULES', name: 'five-stats', version: 1 },
  { kind: 'PORTRAIT_MAP', name: '191-map', version: 1 },
] as const;
const presetKeys = ['regular', 'speed', 'beginner', 'hardcore'] as const;
const presetRoot = new URL('../../../../resources/preset/', import.meta.url);
const identity = { id: 'integration-v01', label: '통합판 v0.1 · 191년 군웅할거' } as const;
const reasons = {
  RULES_UNAVAILABLE: '통합판의 도시 자원 규칙을 준비하고 있습니다.',
  RESOURCES_UNAVAILABLE: '게시된 통합판 생성 자원을 확인하지 못했습니다.',
  PRESETS_UNAVAILABLE: '생성 프리셋을 확인하지 못했습니다.',
} as const;
type Unavailable = typeof identity & { available: false; code: keyof typeof reasons; reason: string };
export type CreationPreset = {
  key: string;
  label: string;
  contentHash: string;
  turnTermMinutes: number;
  descriptions: string[];
};
export type AvailableCreationProfile = typeof identity & {
  available: true;
  selection: typeof creationSelection;
  scenarioTitle: string;
  mapName: string;
  startYear: number;
  counts: {
    nations: number;
    generals: number;
    cities: number;
    gates: number;
    ports: number;
    fields: number;
    anchors: number;
  };
  resources: Array<{ kind: string; key: string; version: number; contentHash: string }>;
  ruleFeatures: string[];
  presets: CreationPreset[];
  suggestedEndYear: number;
};
export type CreationProfile = AvailableCreationProfile | Unavailable;
type Resource = Pick<PublishedResource, 'kind' | 'name' | 'version' | 'content' | 'contentHash'>;
export type PresetSource = { key: string; value: unknown };
function unavailable(code: keyof typeof reasons): Unavailable {
  return { ...identity, available: false, code, reason: reasons[code] };
}

// 조회용 검증과 요약만 한다. 월드 준비·RNG·DB 쓰기는 엔진 소관이다.
export function creationProfile(
  rows: readonly Resource[],
  presets: readonly PresetSource[],
  registry: RuleRegistry = ruleRegistry,
): CreationProfile {
  try {
    checkRuleFeatures([...creationFeatures], registry);
  } catch {
    return unavailable('RULES_UNAVAILABLE');
  }
  let map: z.infer<typeof operationalMapSchema>, scenario: z.infer<typeof scenarioSchema>;
  try {
    const selected = creationRefs.map((ref) => {
      const matches = rows.filter(
        (row) => row.kind === ref.kind && row.name === ref.name && row.version === ref.version,
      );
      if (matches.length !== 1 || hashState(matches[0]!.content) !== matches[0]!.contentHash) throw new Error();
      return matches[0]!;
    });
    const [mapRow, scenarioRow, unitRow, statRow, portraitRow] = selected;
    map = operationalMapSchema.parse(mapRow!.content);
    scenario = scenarioSchema.parse(scenarioRow!.content);
    const stat = statRulesSchema.parse(statRow!.content);
    const unit = unitRow!.content as { id?: unknown } | null;
    if (
      map.id !== creationSelection.mapKey ||
      scenario.id !== creationSelection.scenarioKey ||
      unit?.id !== creationSelection.unitSetKey ||
      stat.stat.count !== 5 ||
      scenario.startYear !== 191 ||
      scenario.nation.length !== 21 ||
      scenario.general.length !== 491 ||
      scenario.generalStats?.length !== 491 ||
      new Set(scenario.generalStats.map((entry) => entry.generalId)).size !== 491 ||
      scenario.generalStats.some((entry) => entry.generalId > 491)
    )
      throw new Error();
    const counts = (kind: string) => map.sites.filter((site) => site.kind === kind).length;
    if (counts('CITY') !== 53 || counts('PASS') !== 8 || counts('PORT') !== 6 || counts('FIELD') !== 13)
      throw new Error();
    if (
      validateWorldResources({
        map: mapRow!.content,
        scenario: scenarioRow!.content,
        unitSet: unitRow!.content,
        statRules: statRow!.content,
        portraitMap: portraitRow!.content,
      }).status !== 'pass'
    )
      throw new Error();
    const portraits = (portraitRow!.content as { portraits?: Record<string, unknown> }).portraits;
    if (!portraits || scenario.general.some((general) => !Object.hasOwn(portraits, general[1]))) throw new Error();
  } catch {
    return unavailable('RESOURCES_UNAVAILABLE');
  }
  const options: CreationPreset[] = [];
  try {
    for (const key of presetKeys) {
      const entries = presets.filter((entry) => entry.key === key);
      if (entries.length !== 1) throw new Error();
      const preset = parsePreset(entries[0]!.value);
      if (preset.commands) throw new Error();
      options.push({
        key,
        label: preset.name,
        contentHash: hashState(preset),
        turnTermMinutes: preset.turnTermMinutes,
        descriptions: [
          `NPC 공격 성향 ${preset.npc.aggression}배`,
          `건국 보호 ${preset.protection.foundUntilMonths}개월 · 평화 보호 ${preset.protection.peaceMonths}개월`,
          preset.boost.smallWorld ? '소규모 월드 참가 보정 적용' : '소규모 월드 참가 보정 없음',
          preset.boost.lateJoin ? `늦은 참가 보정 ${preset.boost.lateJoin.fromYear}년차부터` : '늦은 참가 보정 없음',
        ],
      });
    }
  } catch {
    return unavailable('PRESETS_UNAVAILABLE');
  }
  return {
    ...identity,
    available: true,
    selection: { ...creationSelection },
    scenarioTitle: scenario.title,
    mapName: map.name,
    startYear: scenario.startYear,
    counts: {
      nations: scenario.nation.length,
      generals: scenario.general.length,
      cities: 53,
      gates: 8,
      ports: 6,
      fields: 13,
      anchors: 61,
    },
    resources: creationRefs.map((ref) => ({
      kind: ref.kind,
      key: ref.name,
      version: ref.version,
      contentHash: rows.find((row) => row.kind === ref.kind && row.name === ref.name && row.version === ref.version)!
        .contentHash,
    })),
    ruleFeatures: [...creationFeatures],
    presets: options,
    suggestedEndYear: 201,
  };
}

export async function getWorldCreationOptions(ctx: Context, input: z.infer<typeof creationOptionsInput>) {
  if (!ctx.user || ctx.user.id !== input.expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
  ctx.reply.header('Cache-Control', 'no-store');
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        const userId = await requireCurrentAdmin(tx, ctx, false);
        const rows = await tx.gameResource.findMany({
          where: { status: 'PUBLISHED', OR: creationRefs.map((ref) => ({ ...ref })) },
          select: { kind: true, name: true, version: true, content: true, contentHash: true },
        });
        const presets = await Promise.all(
          presetKeys.map(async (key) => {
            try {
              return { key, value: JSON.parse(await readFile(new URL(`${key}.json`, presetRoot), 'utf8')) as unknown };
            } catch {
              return { key, value: null };
            }
          }),
        );
        const profile = creationProfile(rows, presets);
        return { userId, revision: hashState(profile), profiles: [profile] };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '생성 설정을 확인하지 못했습니다.' });
  }
}
