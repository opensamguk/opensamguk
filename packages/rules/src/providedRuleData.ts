import data from './providedRuleData.json' with { type: 'json' };
import { defaultOfficeEffects } from './personnel/residentOffice';
import { createRelationsData } from './relations/data';
import type { JsonValue } from './model/world';
import type { WorldInit } from './world/bootstrap';

// D-104: 수치는 생성 기록에 고정한다. 지명은 선택한 지도의 키로 결합한다.
export function providedRuleData(initial: WorldInit, turnTermMinutes: number): Record<string, JsonValue> {
  const cities = initial.cities.filter((city) => city.kind !== 'PASS' && city.kind !== 'FIELD');
  const seat = cities.find((city) => city.name === '낙양') ?? [...cities].sort((a, b) => a.cityKey - b.cityKey)[0];
  if (!seat) throw new Error('황실 소재지로 쓸 도시가 없습니다.');
  const logistics = structuredClone(data['logistics-v1']);
  const armTypes = [
    ...new Set(initial.unitSet.crewTypes.filter((row) => row.armType > 0).map((row) => row.armType)),
  ].sort((a, b) => a - b);
  const costs = logistics.recruitPer100 as Record<string, { iron: number; wood: number; horses: number }>;
  for (const arm of armTypes) if (!costs[String(arm)]) throw new Error(`병과 ${arm}의 물류 비용이 없습니다.`);
  return {
    ...(initial.operationalMap ? {} : { 'march-supply-v1': { version: 1, cellSize: 16, routes: [] } }),
    'logistics-v1': {
      ...logistics,
      specialties: logistics.specialties
        .flatMap(({ city: name, ...row }) => {
          const city = cities.find((city) => city.name === name);
          return city ? [{ ...row, cityKey: city.cityKey }] : [];
        })
        .sort((a, b) => a.cityKey - b.cityKey),
      recruitPer100: Object.fromEntries(armTypes.map((arm) => [String(arm), costs[String(arm)]!])),
    },
    'governance-v1': { ...structuredClone(data['governance-v1']), seatCityKey: seat.cityKey },
    'lineage-v1': structuredClone(data['lineage-v1']),
    'heritage-v1': structuredClone(data['heritage-v1']),
    'equipment-v1': structuredClone(data['equipment-v1']),
    'stratagem-cards-v1': structuredClone(data['stratagem-cards-v1']),
    'city-upgrade-v1': { version: 1, enabled: true },
    'office-effects': structuredClone(defaultOfficeEffects),
    'relations-v1': createRelationsData(initial),
    policy: { version: 1, turnTermMinutes },
  };
}
