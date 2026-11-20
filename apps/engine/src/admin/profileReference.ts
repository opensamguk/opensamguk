import { FEATURE_PROFILE_DATA_KEYS, featureProfileSchema, type ReplayOriginV3 } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';

// 상시 실행 목록에서 프로필 버전을 추론하지 않는다. 고정 해시로 원본 설정의 판을 식별한다.
export function matchesPinnedFeatureProfile(
  origin: ReplayOriginV3,
  selection: { scenario: string; map: string; unitSet: string; statRules: string; portraitMap: string },
  reference: { key: string; contentHash: string },
): boolean {
  return ([1, 2, 3] as const).some((version) => {
    const keys: readonly string[] = [
      ...FEATURE_PROFILE_DATA_KEYS,
      ...(version >= 2 ? ['equipment-v1'] : []),
      ...(version === 3 ? ['stratagem-cards-v1'] : []),
    ];
    const parsed = featureProfileSchema.safeParse({
      version,
      key: reference.key,
      scenarioKey: selection.scenario,
      mapKey: selection.map,
      ...(version === 3
        ? {
            unitSetKey: selection.unitSet,
            statRulesKey: selection.statRules,
            portraitMapKey: selection.portraitMap,
          }
        : {}),
      featureData: Object.fromEntries(keys.map((key) => [key, origin.featureData?.[key]])),
    });
    if (!parsed.success) return false;
    if (hashState(parsed.data) === reference.contentHash) return true;
    const upgrade = origin.featureData?.['city-upgrade-v1'];
    if (upgrade === undefined) return false;
    const configured = featureProfileSchema.safeParse({
      ...parsed.data,
      featureData: { ...parsed.data.featureData, 'city-upgrade-v1': upgrade },
    });
    return configured.success && hashState(configured.data) === reference.contentHash;
  });
}
