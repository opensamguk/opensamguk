import type { Prisma } from '@opensamguk/db';
import { readFile } from 'node:fs/promises';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { PublishedResource } from '@opensamguk/db';
import {
  checkRuleFeatures,
  DIPLOMATIC_COOLDOWN_FEATURE,
  PLAYER_AUTOPLAY_FEATURE,
  CITY_SEASONAL_EVENTS_FEATURE,
  NATION_PHILOSOPHY_FEATURE,
  COURT_PROMOTION_FEATURE,
  RESEARCH_ERA_FEATURE,
  GENERAL_CONDITION_FEATURE,
  GENERAL_PERSONALITY_FEATURE,
  COMBAT_SPECIALTY_FEATURE,
  DOMESTIC_SPECIALTY_FEATURE,
  GENERAL_PROFICIENCY_FEATURE,
  DEFENSE_STANCE_FEATURE,
  NPC_NATION_POLICY_FEATURE,
  NATION_RESTRICTIONS_FEATURE,
  INACTIVE_REMOVAL_FEATURE,
  RANKED_AID_FEATURE,
  RICE_MARKET_FEATURE,
  parsePreset,
  ruleRegistry,
  scenarioSchema,
  statRulesSchema,
  type RuleRegistry,
  featureProfileSchema,
  type FeatureProfile,
  parseResourceKey,
} from '@opensamguk/rules';
import { operationalMapSchema, validateWorldResources } from '@opensamguk/rules/resource-validation';
import { hashState } from '@opensamguk/shared/node';
import { resourceRoot } from '@opensamguk/shared/resource-root';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

export const creationOptionsInput = z.strictObject({
  expectedUserId: z.uuid(),
  expandedProfiles: z.boolean().optional(),
});
export const creationFeatures = [
  'battle-affinity-v2',
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
const identity = { id: 'integration-v01', label: '통합판 v0.1 · 191년 군웅할거' } as const;
const profileIds = ['integration-v01', 'san10-191', 'san10-empty'] as const;
type ProfileId = keyof typeof contracts;
type Selection = Record<keyof typeof creationSelection, string>;
type Identity = { id: ProfileId | 'integration-v01-expanded' | `san10-expanded-${string}`; label: string };
const san10Selection = { ...creationSelection, mapKey: 'san10', unitSetKey: 'expanded' } as const;
const contracts = {
  'integration-v01': {
    ...identity,
    selection: creationSelection,
    startYear: 191,
    nations: 21,
    counts: { cities: 53, gates: 8, ports: 6, fields: 13, anchors: 61 },
    presets: presetKeys,
    suggestedEndYear: 201,
  },
  'san10-191': {
    id: 'san10-191',
    label: 'SAN10 · 191년 군웅할거',
    selection: { ...san10Selection, scenarioKey: 'san10-191' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 201,
  },
  'san10-empty': {
    id: 'san10-empty',
    label: 'SAN10 · 180년 공백지',
    selection: { ...san10Selection, scenarioKey: 'san10-empty' },
    startYear: 180,
    nations: 0,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: ['empty'],
    suggestedEndYear: 190,
  },
  'san10-191-expanded': {
    id: 'san10-191-expanded',
    label: 'SAN10 확장 · 191년 군웅할거',
    selection: { ...san10Selection, scenarioKey: 'san10-191@2' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 231,
  },
  'san10-191-lifecycle': {
    id: 'san10-191-lifecycle',
    label: 'SAN10 확장 · 선양·방랑',
    selection: { ...san10Selection, scenarioKey: 'san10-191@2' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 231,
  },
  'san10-191-research': {
    id: 'san10-191-research',
    label: 'SAN10 확장 · 병종 연구',
    selection: { ...san10Selection, scenarioKey: 'san10-191@2' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 231,
  },
  'san10-191-border-return': {
    id: 'san10-191-border-return',
    label: 'SAN10 확장 · 접경귀환',
    selection: { ...san10Selection, scenarioKey: 'san10-191@2' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 231,
  },
  'san10-191-general-condition': {
    id: 'san10-191-general-condition',
    label: 'SAN10 확장 · 장수 부상과 관직 효과',
    selection: { ...san10Selection, scenarioKey: 'san10-191@2' },
    startYear: 191,
    nations: 21,
    counts: { cities: 147, gates: 8, ports: 0, fields: 0, anchors: 155 },
    presets: presetKeys,
    suggestedEndYear: 231,
  },
} as const;
const expandedProfiles = [
  ['integration-v01', 'expanded-191-v3'],
  ['san10-191-expanded', 'expanded-191-v4'],
  ['san10-191-lifecycle', 'expanded-191-v5'],
  ['san10-191-research', 'expanded-191-v6'],
  ['san10-191-border-return', 'expanded-191-v7'],
  ['san10-191-general-condition', 'expanded-191-v8'],
] as const satisfies readonly (readonly [ProfileId, string])[];
function profileRefs(id: ProfileId) {
  const selection = contracts[id].selection;
  return [
    { kind: 'MAP', ...parseResourceKey(selection.mapKey) },
    { kind: 'SCENARIO', ...parseResourceKey(selection.scenarioKey) },
    { kind: 'UNIT_SET', ...parseResourceKey(selection.unitSetKey) },
    { kind: 'STAT_RULES', ...parseResourceKey(selection.statRulesKey) },
    { kind: 'PORTRAIT_MAP', ...parseResourceKey(selection.portraitMapKey) },
  ] as const;
}
const reasons = {
  RULES_UNAVAILABLE: '통합판의 도시 자원 규칙을 준비하고 있습니다.',
  RESOURCES_UNAVAILABLE: '게시된 통합판 생성 자원을 확인하지 못했습니다.',
  PRESETS_UNAVAILABLE: '생성 프리셋을 확인하지 못했습니다.',
  FEATURE_PROFILE_UNAVAILABLE: '확장 월드 설정을 확인하지 못했습니다.',
} as const;
type Unavailable = Identity & { available: false; code: keyof typeof reasons; reason: string };
export type CreationPreset = {
  key: string;
  label: string;
  contentHash: string;
  turnTermMinutes: number;
  descriptions: string[];
};
const scenarioCategorySchema = z.enum(['history', 'if', 'empty']);
export type AvailableCreationProfile = Identity & {
  available: true;
  selection: Selection;
  scenarioTitle: string;
  scenarioCategory?: z.infer<typeof scenarioCategorySchema>;
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
    markers?: number;
    roads?: number;
  };
  resources: Array<{ kind: string; key: string; version: number; contentHash: string }>;
  ruleFeatures: string[];
  presets: CreationPreset[];
  suggestedEndYear: number;
  featureProfileKey?: string;
  featureProfileHash?: string;
};
export type CreationProfile = AvailableCreationProfile | Unavailable;
type Resource = Pick<PublishedResource, 'kind' | 'name' | 'version' | 'content' | 'contentHash'>;
export type PresetSource = { key: string; value: unknown };
function unavailable(id: ProfileId, code: keyof typeof reasons): Unavailable {
  const profile = contracts[id];
  return { id: profile.id, label: profile.label, available: false, code, reason: reasons[code] };
}

// 조회용 검증과 요약만 한다. 월드 준비·RNG·DB 쓰기는 엔진 소관이다.
export function creationProfile(
  rows: readonly Resource[],
  presets: readonly PresetSource[],
  registry: RuleRegistry = ruleRegistry,
  profileId: ProfileId = 'integration-v01',
): CreationProfile {
  const profile = contracts[profileId],
    refs = profileRefs(profileId);
  try {
    checkRuleFeatures([...creationFeatures], registry);
  } catch {
    return unavailable(profileId, 'RULES_UNAVAILABLE');
  }
  let map: z.infer<typeof operationalMapSchema>, scenario: z.infer<typeof scenarioSchema>;
  try {
    const selected = refs.map((ref) => {
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
      map.id !== parseResourceKey(profile.selection.mapKey).name ||
      scenario.id !== parseResourceKey(profile.selection.scenarioKey).name ||
      unit?.id !== parseResourceKey(profile.selection.unitSetKey).name ||
      stat.stat.count !== 5 ||
      scenario.startYear !== profile.startYear ||
      scenario.nation.length !== profile.nations ||
      scenario.general.length !== 491 ||
      scenario.generalStats?.length !== 491 ||
      new Set(scenario.generalStats.map((entry) => entry.generalId)).size !== 491 ||
      scenario.generalStats.some((entry) => entry.generalId > 491)
    )
      throw new Error();
    const counts = (kind: string) => map.sites.filter((site) => site.kind === kind).length;
    if (
      counts('CITY') !== profile.counts.cities ||
      counts('PASS') !== profile.counts.gates ||
      counts('PORT') !== profile.counts.ports ||
      counts('FIELD') !== profile.counts.fields ||
      counts('CITY') + counts('PASS') !== profile.counts.anchors
    )
      throw new Error();
    if (
      profile.selection.mapKey === 'san10' &&
      (map.sites.length !== 155 ||
        map.routes.length !== 191 ||
        map.routes.some((route) => !route.enabled || route.direction !== 'BOTH') ||
        map.canvas.width !== 1400 ||
        map.canvas.height !== 1000)
    )
      throw new Error();
    if (
      profileId === 'san10-empty' &&
      (scenario.diplomacy.length !== 0 || scenario.general.some((general) => general[3] !== 0 || general[8] !== 0))
    )
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
    return unavailable(profileId, 'RESOURCES_UNAVAILABLE');
  }
  const options: CreationPreset[] = [];
  try {
    for (const key of profile.presets) {
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
    return unavailable(profileId, 'PRESETS_UNAVAILABLE');
  }
  return {
    id: profile.id,
    label: profile.label,
    available: true,
    selection: { ...profile.selection },
    scenarioTitle: scenario.title,
    mapName: map.name,
    startYear: scenario.startYear,
    counts: {
      nations: scenario.nation.length,
      generals: scenario.general.length,
      ...profile.counts,
      ...(profile.selection.mapKey === 'san10' ? { markers: 155, roads: 191 } : {}),
    },
    resources: refs.map((ref) => ({
      kind: ref.kind,
      key: ref.name,
      version: ref.version,
      contentHash: rows.find((row) => row.kind === ref.kind && row.name === ref.name && row.version === ref.version)!
        .contentHash,
    })),
    ruleFeatures: [...creationFeatures],
    presets: options,
    suggestedEndYear: profile.suggestedEndYear,
  };
}

export function expandedCreationProfile(
  rows: readonly Resource[],
  presets: readonly PresetSource[],
  data: unknown,
  registry: RuleRegistry = ruleRegistry,
  profileId: (typeof expandedProfiles)[number][0] = 'integration-v01',
): CreationProfile {
  const identity =
    profileId === 'integration-v01'
      ? ({ id: 'integration-v01-expanded', label: '통합판 확장 · 191년 군웅할거' } as const)
      : { id: contracts[profileId].id, label: contracts[profileId].label };
  let profile: FeatureProfile;
  try {
    profile = featureProfileSchema.parse(data);
    if (
      profile.key !== expandedProfiles.find(([id]) => id === profileId)?.[1] ||
      !profile.ruleFeatures.includes('battle-affinity-v2') ||
      (profileId === 'san10-191-lifecycle' && !profile.ruleFeatures.includes('nation-lifecycle-v1')) ||
      (profileId === 'san10-191-research' && !profile.ruleFeatures.includes('nation-research-v1')) ||
      (profileId === 'san10-191-border-return' &&
        (!profile.ruleFeatures.includes('border-return-v1') || !profile.ruleFeatures.includes('nation-research-v1'))) ||
      (profileId === 'san10-191-general-condition' && !profile.ruleFeatures.includes(GENERAL_CONDITION_FEATURE)) ||
      profile.scenarioKey !== contracts[profileId].selection.scenarioKey ||
      profile.mapKey !== contracts[profileId].selection.mapKey ||
      (profileId !== 'integration-v01' &&
        (profile.version !== 3 ||
          profile.unitSetKey !== contracts[profileId].selection.unitSetKey ||
          profile.statRulesKey !== contracts[profileId].selection.statRulesKey ||
          profile.portraitMapKey !== contracts[profileId].selection.portraitMapKey))
    )
      throw new Error();
    checkRuleFeatures(profile.ruleFeatures, registry);
  } catch {
    return {
      ...identity,
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
      reason: reasons.FEATURE_PROFILE_UNAVAILABLE,
    };
  }
  const base = creationProfile(rows, presets, registry, profileId);
  if (!base.available) return { ...base, ...identity };
  return {
    ...base,
    ...identity,
    ruleFeatures: [...profile.ruleFeatures],
    featureProfileKey: profile.key,
    featureProfileHash: hashState(profile),
    suggestedEndYear: 231,
  };
}

const artifactMap = 'san10-expanded';
export const artifactSelection = {
  mapKey: artifactMap,
  unitSetKey: 'expanded',
  statRulesKey: 'five-stats',
  portraitMapKey: 'san10-expanded-portraits',
};
export const artifactScenarioPattern = '^san10-expanded-[a-z0-9]+$';
export const artifactPublication = { status: 'PUBLISHED', createdBy: null, publishedBy: null } as const;
export const artifactMapVersion = { kind: 'MAP', name: artifactMap, version: 1, ...artifactPublication } as const;
const artifactRefs = [
  artifactMapVersion,
  { kind: 'UNIT_SET', name: artifactSelection.unitSetKey, version: 1 },
  { kind: 'STAT_RULES', name: artifactSelection.statRulesKey, version: 1 },
  { kind: 'PORTRAIT_MAP', name: artifactSelection.portraitMapKey, version: 1 },
] as const;

async function artifactCreationProfiles(
  tx: Prisma.TransactionClient,
  presets: readonly PresetSource[],
): Promise<CreationProfile[] | null> {
  const rows = await tx.gameResource.findMany({
    where: { status: 'PUBLISHED', OR: artifactRefs.map((ref) => ({ ...ref })) },
    select: { kind: true, name: true, version: true, contentHash: true },
  });
  if (!rows.some((row) => row.kind === 'MAP')) return null;
  if (rows.length !== artifactRefs.length) throw new Error('확장 확정판 공통 자원을 확인하세요.');
  const entries = await tx.$queryRaw<
    Array<{
      name: `san10-expanded-${string}`;
      title: string;
      year: number;
      generals: number;
      nations: number;
      contentHash: string;
    }>
  >`
    SELECT name, content->>'title' AS title, (content->>'startYear')::int AS year,
      jsonb_array_length(content->'general') AS generals, jsonb_array_length(content->'nation') AS nations, "contentHash"
    FROM "GameResource"
    WHERE kind = 'SCENARIO' AND version = 1 AND status = 'PUBLISHED'
      AND "createdBy" IS NULL AND "publishedBy" IS NULL
      AND name ~ ${artifactScenarioPattern} AND content->>'requiredMap' = ${artifactMap}
    ORDER BY (name = 'san10-expanded-empty'), year, name`;
  const categories = z
    .record(z.string(), scenarioCategorySchema)
    .parse(JSON.parse(await readFile(new URL('scenario/san10-expanded-categories.json', resourceRoot()), 'utf8')));
  if (entries.length !== Object.keys(categories).length || entries.some(({ name }) => !categories[name]))
    throw new Error('확장 확정판 시나리오 분류를 확인하세요.');
  const regular = parsePreset(presets.find((row) => row.key === 'regular')?.value);
  const empty = parsePreset(presets.find((row) => row.key === 'empty')?.value);
  const resources = rows.map((row) => ({
    kind: row.kind,
    key: row.name,
    version: row.version,
    contentHash: row.contentHash,
  }));
  return entries.map((entry) => {
    const scenarioCategory = categories[entry.name]!;
    const isEmpty = scenarioCategory === 'empty';
    const preset = isEmpty ? empty : regular;
    return {
      id: entry.name,
      label: entry.title,
      available: true,
      selection: { ...artifactSelection, scenarioKey: entry.name },
      scenarioTitle: entry.title,
      scenarioCategory,
      mapName: 'SAN10 확장 확정판',
      startYear: entry.year,
      counts: {
        cities: 314,
        gates: 8,
        ports: 0,
        fields: 0,
        anchors: 322,
        markers: 322,
        roads: 467,
        generals: entry.generals,
        nations: entry.nations,
      },
      resources: [...resources, { kind: 'SCENARIO', key: entry.name, version: 1, contentHash: entry.contentHash }],
      ruleFeatures: [
        ...creationFeatures,
        'treaty-break',
        'treaty-expanded',
        'treaty-trade',
        DIPLOMATIC_COOLDOWN_FEATURE,
        PLAYER_AUTOPLAY_FEATURE,
        DEFENSE_STANCE_FEATURE,
        NPC_NATION_POLICY_FEATURE,
        NATION_RESTRICTIONS_FEATURE,
        INACTIVE_REMOVAL_FEATURE,
        GENERAL_PERSONALITY_FEATURE,
        COMBAT_SPECIALTY_FEATURE,
        DOMESTIC_SPECIALTY_FEATURE,
        GENERAL_PROFICIENCY_FEATURE,
        CITY_SEASONAL_EVENTS_FEATURE,
        NATION_PHILOSOPHY_FEATURE,
        COURT_PROMOTION_FEATURE,
        RESEARCH_ERA_FEATURE,
        RANKED_AID_FEATURE,
        RICE_MARKET_FEATURE,
      ].sort(),
      presets: [
        {
          key: isEmpty ? 'empty' : 'regular',
          label: preset.name,
          contentHash: hashState(preset),
          turnTermMinutes: preset.turnTermMinutes,
          descriptions: [],
        },
      ],
      suggestedEndYear: entry.year + 40,
    };
  });
}

export async function getWorldCreationOptions(ctx: Context, input: z.infer<typeof creationOptionsInput>) {
  if (!ctx.user || ctx.user.id !== input.expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
  ctx.reply.header('Cache-Control', 'no-store');
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        const userId = await requireCurrentAdmin(tx, ctx, false);
        const selectedIds: ProfileId[] = [...profileIds];
        if (input.expandedProfiles === true) selectedIds.push(...expandedProfiles.map(([id]) => id));
        const refs = [
          ...new Map(
            selectedIds.flatMap(profileRefs).map((ref) => [`${ref.kind}/${ref.name}/${ref.version}`, ref]),
          ).values(),
        ];
        const rows = await tx.gameResource.findMany({
          where: { status: 'PUBLISHED', OR: refs.map((ref) => ({ ...ref })) },
          select: { kind: true, name: true, version: true, content: true, contentHash: true },
        });
        const presets = await Promise.all(
          [...presetKeys, 'empty'].map(async (key) => {
            try {
              return {
                key,
                value: JSON.parse(await readFile(new URL(`preset/${key}.json`, resourceRoot()), 'utf8')) as unknown,
              };
            } catch {
              return { key, value: null };
            }
          }),
        );
        const artifactProfiles = await artifactCreationProfiles(tx, presets);
        if (artifactProfiles) return { userId, revision: hashState(artifactProfiles), profiles: artifactProfiles };
        const profiles = profileIds.map((id) => creationProfile(rows, presets, ruleRegistry, id));
        if (input.expandedProfiles === true) {
          for (const [id, key] of expandedProfiles) {
            let value: unknown;
            try {
              value = JSON.parse(await readFile(new URL(`feature-profile/${key}.json`, resourceRoot()), 'utf8'));
            } catch {
              value = null;
            }
            profiles.push(expandedCreationProfile(rows, presets, value, ruleRegistry, id));
          }
        }
        return { userId, revision: hashState(profiles), profiles };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '생성 설정을 확인하지 못했습니다.' });
  }
}
