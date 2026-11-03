import { z } from 'zod';
import { CITY_RESOURCE_MAX, readCityResourcesState } from '../cityResources/state';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { governanceId, governanceQuantity } from './config';
import { readGovernanceState } from './state';

export const governanceMovementSchema = z.strictObject({
  kind: z.enum(['TRIBUTE', 'STIPEND']),
  refId: governanceId,
  holder: z.enum(['city', 'general']),
  holderId: governanceId,
  resource: z.enum(['gold', 'rice']),
  delta: z
    .number()
    .int()
    .min(-CITY_RESOURCE_MAX)
    .max(CITY_RESOURCE_MAX)
    .refine((value) => value !== 0),
  // 거점이 함락되거나 계약이 끝나도 당시 당사국으로 과거 원장의 공개 범위를 판정한다.
  fromNationId: governanceId,
  toNationId: governanceId,
});
export type GovernanceMovement = z.infer<typeof governanceMovementSchema>;

export function assertGovernanceConserved(before: WorldView, after: WorldView, value: unknown): void {
  const rows = z.array(governanceMovementSchema).parse(value);
  const oldCities = readCityResourcesState(before.cityResources, before);
  const newCities = readCityResourcesState(after.cityResources, after);
  const changes = new Map<string, bigint>();
  const add = (key: string, delta: bigint) => changes.set(key, (changes.get(key) ?? 0n) + delta);
  const expected = cloneWorld(before);
  if (after.governance) expected.governance = readGovernanceState(after.governance);
  else delete expected.governance;
  expected.cityResources = oldCities;
  for (const [key, city] of Object.entries(oldCities.cities)) {
    const next = newCities.cities[key];
    if (!next) throw new Error('황실 정산에서 도시가 사라졌습니다.');
    for (const resource of ['gold', 'rice'] as const) {
      add(`city:${key}:${resource}`, BigInt(next[resource]) - BigInt(city[resource]));
      expected.cityResources.cities[key]![resource] = next[resource];
    }
  }
  for (const [key, general] of Object.entries(before.generals)) {
    const next = after.generals[Number(key)];
    if (!next) throw new Error('황실 정산에서 장수가 사라졌습니다.');
    governanceQuantity.parse(general.gold);
    governanceQuantity.parse(next.gold);
    add(`general:${key}:gold`, BigInt(next.gold) - BigInt(general.gold));
    expected.generals[Number(key)]!.gold = next.gold;
  }
  if (JSON.stringify(expected) !== JSON.stringify(cloneWorld(after)))
    throw new Error('황실 정산이 허용한 금·쌀 밖의 상태를 바꿨습니다.');
  const transfers = new Map<string, GovernanceMovement[]>();
  for (const row of rows) {
    if (!before.nations[row.fromNationId] || !before.nations[row.toNationId])
      throw new Error('황실 원장의 당사국이 없습니다.');
    const exists = row.holder === 'city' ? oldCities.cities[String(row.holderId)] : before.generals[row.holderId];
    if (!exists) throw new Error('황실 원장의 보유처가 없습니다.');
    const holderNation =
      row.holder === 'city' ? before.cities[row.holderId]?.nationId : before.generals[row.holderId]?.nationId;
    if (holderNation !== (row.delta < 0 ? row.fromNationId : row.toNationId))
      throw new Error('황실 원장의 보유처와 당시 당사국이 다릅니다.');
    if (
      (row.kind === 'TRIBUTE' && row.holder !== 'city') ||
      (row.kind === 'STIPEND' &&
        (row.resource !== 'gold' ||
          row.refId > 3 ||
          (row.delta < 0 ? row.holder !== 'city' : row.holder !== 'general')))
    )
      throw new Error('황실 이체 종류와 보유처·방향이 다릅니다.');
    add(`${row.holder}:${row.holderId}:${row.resource}`, -BigInt(row.delta));
    const key = `${row.kind}:${row.refId}:${row.resource}`;
    const pair = transfers.get(key) ?? [];
    pair.push(row);
    transfers.set(key, pair);
  }
  for (const pair of transfers.values()) {
    if (
      pair.length !== 2 ||
      pair[0]!.delta >= 0 ||
      pair[1]!.delta !== -pair[0]!.delta ||
      pair[0]!.fromNationId !== pair[1]!.fromNationId ||
      pair[0]!.toNationId !== pair[1]!.toNationId ||
      (pair[0]!.holder === pair[1]!.holder && pair[0]!.holderId === pair[1]!.holderId)
    )
      throw new Error('황실 이체의 출금·입금 쌍이 다릅니다.');
  }
  if ([...changes.values()].some((delta) => delta !== 0n))
    throw new Error('황실 보유처 증감과 이체 원장이 보존되지 않았습니다.');
}
