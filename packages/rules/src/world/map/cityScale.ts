import { z } from 'zod';
import { cityValues, type MapResource, type ScenarioResource } from '../resources';

export const CITY_SCALE_FEATURE = 'city-scale-v1';
export const CITY_SCALE_FIELDS = ['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const;
export const WASTELAND_MAX = Object.freeze({
  population: 10_000,
  agriculture: 200,
  commerce: 200,
  security: 200,
  defence: 200,
  wall: 200,
});
export const WASTELAND_INITIAL = Object.freeze({
  population: 1_000,
  agriculture: 0,
  commerce: 0,
  security: 0,
  defence: 100,
  wall: 100,
});
export const cityScaleRecordSchema = z.strictObject({
  cities: z
    .array(
      z.strictObject({
        cityKey: z.number().int().positive().max(2_147_483_647),
        level: z.number().int().min(0).max(9),
        max: cityValues.strict(),
        ruin: z.literal(true).optional(),
      }),
    )
    .min(1)
    .max(300)
    .refine((rows) => rows.every((row, index) => index === 0 || rows[index - 1]!.cityKey < row.cityKey)),
});
export type CityScaleRecord = z.infer<typeof cityScaleRecordSchema>;
export type CityScaleValues = MapResource['cities'][number]['max'];
export type ScaleAnchor = MapResource['cities'][number] & { kind?: 'CITY' | 'PASS' };
type ScaleRequest = NonNullable<ScenarioResource['cityScale']>['cities'][number];

export function ruinMaximum(base: Readonly<CityScaleValues>, percent: 10 | 40 | 70): CityScaleValues {
  const max = { ...base };
  for (const field of CITY_SCALE_FIELDS) max[field] = Math.floor((base[field] * percent) / 100);
  return max;
}

export function checkMapCityScale(city: ScaleAnchor): void {
  if (city.kind === 'PASS') return;
  if (!Number.isInteger(city.level) || city.level < 0 || city.level > 9) throw new Error('도시 규모는 0~9여야 합니다.');
  if (city.level === 9 && !['낙양', '장안'].includes(city.name))
    throw new Error('경 규모는 낙양과 장안에만 지정할 수 있습니다.');
  if (
    city.level === 0 &&
    CITY_SCALE_FIELDS.some(
      (field) => city.max[field] !== WASTELAND_MAX[field] || city.initial[field] !== WASTELAND_INITIAL[field],
    )
  )
    throw new Error('무 규모의 초기값과 최대치를 확인하세요.');
}

// 평균은 변경 전 지도에서 한 번만 구한다. 여러 덮어쓰기의 순서가 결과를 바꾸지 않는다.
export function resolveCityScale<T extends ScaleAnchor>(
  source: readonly T[],
  requests: readonly ScaleRequest[] = [],
): { cities: T[]; record?: CityScaleRecord } {
  for (const city of source) checkMapCityScale(city);
  const byName = new Map(source.map((city) => [city.name, city]));
  const requested = new Map<string, ScaleRequest>();
  for (const request of requests) {
    const city = byName.get(request.city);
    if (!city || city.kind === 'PASS') throw new Error('도시 규모 지정 대상은 지도에 있는 도시여야 합니다.');
    if (requested.has(request.city)) throw new Error('도시 규모 지정이 겹칩니다.');
    if (request.level === undefined && request.ruin !== true) throw new Error('도시 규모나 폐허 상태를 지정하세요.');
    if (request.level !== undefined && (!Number.isInteger(request.level) || request.level < 0 || request.level > 9))
      throw new Error('도시 규모는 0~9여야 합니다.');
    requested.set(request.city, request);
  }
  const sample = (level: number) => {
    const sample = source.filter((city) => city.kind !== 'PASS' && city.level === level);
    if (!sample.length) throw new Error('목표 규모의 최대치를 계산할 지도 표본이 없습니다.');
    return sample;
  };
  const sum = (cities: readonly T[], field: (typeof CITY_SCALE_FIELDS)[number]) =>
    cities.reduce((total, city) => total + BigInt(city.max[field]), 0n);
  // 정수 나눗셈의 나머지만 반올림해 평균 차이의 양·음 반 정수 경계를 보존한다.
  const roundRatio = (numerator: bigint, denominator: bigint) =>
    Number(numerator / denominator) + Math.round(Number(numerator % denominator) / Number(denominator));
  const rows: CityScaleRecord['cities'] = [];
  const cities = source.map((city) => {
    if (city.kind === 'PASS') return city;
    const request = requested.get(city.name);
    const level = request?.level ?? city.level;
    let max = { ...city.max };
    let initial = { ...city.initial };
    if (level !== city.level) {
      if (level === 0) {
        max = { ...WASTELAND_MAX };
        initial = { ...WASTELAND_INITIAL };
      } else if (level === 9) {
        if (city.level !== 8 || !['낙양', '장안'].includes(city.name))
          throw new Error('경 규모로 바꿀 대상은 특 규모의 낙양이나 장안이어야 합니다.');
        const large = sample(7),
          special = sample(8),
          largeCount = BigInt(large.length),
          specialCount = BigInt(special.length);
        for (const field of CITY_SCALE_FIELDS)
          max[field] += roundRatio(
            sum(special, field) * largeCount - sum(large, field) * specialCount,
            largeCount * specialCount,
          );
      } else {
        const target = sample(level);
        for (const field of CITY_SCALE_FIELDS) max[field] = roundRatio(sum(target, field), BigInt(target.length));
      }
    }
    for (const field of CITY_SCALE_FIELDS)
      if (!Number.isSafeInteger(max[field]) || max[field] < 0 || max[field] > 2_147_483_647)
        throw new Error('도시 규모의 최대치가 저장 범위를 벗어납니다.');
    if (level !== city.level || level === 0 || level === 9 || request?.ruin)
      rows.push({ cityKey: city.id, level, max: { ...max }, ...(request?.ruin ? { ruin: true } : {}) });
    if (request?.ruin) max = ruinMaximum(max, 10);
    if (level !== city.level || request?.ruin)
      for (const field of CITY_SCALE_FIELDS) initial[field] = Math.min(initial[field], max[field]);
    return { ...city, level, max, initial };
  });
  return {
    cities,
    ...(rows.length
      ? { record: cityScaleRecordSchema.parse({ cities: rows.sort((a, b) => a.cityKey - b.cityKey) }) }
      : {}),
  };
}
