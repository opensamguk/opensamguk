import { z } from 'zod';
import { campaignUnitSchema, type CampaignUnitState } from '../campaign/state';
import type { DeepReadonly } from '../model/world';
import { CITY_RESOURCE_MAX, cityResourceSchema, type CityResourceState } from './state';

const positive = z.number().int().min(1).max(CITY_RESOURCE_MAX);

function addTroops(current: number, amount: number): number {
  const total = current + amount;
  if (total > CITY_RESOURCE_MAX) throw new RangeError('병력 수량 한도를 넘었습니다.');
  return total;
}

// 비용·인구·소속·상한 검사는 호출자가 같은 상태 변경 경계에서 수행한다.
export function recruitCityGarrison(
  value: DeepReadonly<CityResourceState>,
  crewType: number,
  amount: number,
): CityResourceState {
  positive.parse(crewType);
  positive.parse(amount);
  const city = cityResourceSchema.parse(value);
  const row = city.garrison.find((entry) => entry.crewType === crewType);
  if (row) {
    const total = addTroops(row.troops, amount);
    row.train = Math.floor((row.troops * row.train) / total);
    row.atmos = Math.floor((row.troops * row.atmos) / total);
    row.troops = total;
  } else city.garrison.push({ crewType, troops: amount, train: 0, atmos: 0 });
  city.garrison = city.garrison.filter((entry) => entry.troops > 0);
  return cityResourceSchema.parse(city);
}

export function allocateCityGarrison(
  cityValue: DeepReadonly<CityResourceState>,
  unitValue: DeepReadonly<CampaignUnitState>,
  crewType: number,
  amount: number,
): { city: CityResourceState; unit: CampaignUnitState } {
  positive.parse(crewType);
  positive.parse(amount);
  const city = cityResourceSchema.parse(cityValue);
  const unit = campaignUnitSchema.parse(unitValue);
  const row = city.garrison.find((entry) => entry.crewType === crewType);
  if (!row || row.troops < amount) throw new RangeError('배속할 도시 병력이 부족합니다.');
  if (unit.crewType !== crewType) throw new Error('도시 병사와 부곡의 병종이 다릅니다.');
  const total = addTroops(unit.troops, amount);
  unit.train = Math.floor((unit.troops * unit.train + amount * row.train) / total);
  unit.atmos = Math.floor((unit.troops * unit.atmos + amount * row.atmos) / total);
  unit.troops = total;
  row.troops -= amount;
  city.garrison = city.garrison.filter((entry) => entry.troops > 0);
  return { city: cityResourceSchema.parse(city), unit: campaignUnitSchema.parse(unit) };
}
