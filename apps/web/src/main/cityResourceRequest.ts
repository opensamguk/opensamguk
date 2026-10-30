import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

export type CityResourceBoard = inferRouterOutputs<AppRouter>['cityResources']['get'];
export type VisibleCityResources = Extract<CityResourceBoard, { visible: true }>;
export type Allocation = inferRouterInputs<AppRouter>['cityResources']['allocate']['payload'];
export type AllocationRequest = { requestId: string; payload: Allocation };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
export const allocationStorageKey = (userId: string, worldId: string) => `city.resources.pending:${userId}:${worldId}`;

export function readAllocation(storage: Pick<Storage, 'getItem'>, key: string): AllocationRequest | null {
  const raw: unknown = JSON.parse(storage.getItem(key) ?? 'null');
  if (!raw || typeof raw !== 'object' || !('requestId' in raw) || !('payload' in raw)) return null;
  if (typeof raw.requestId !== 'string' || !uuid.test(raw.requestId)) return null;
  const value = raw.payload;
  if (!value || typeof value !== 'object') return null;
  if (!['amount', 'cityKey', 'crewType', 'unitId'].every((key) => key in value)) return null;
  if (!('cityKey' in value) || !('unitId' in value) || !('crewType' in value) || !('amount' in value)) return null;
  if (
    Object.keys(value).length !== 4 ||
    !positive(value.cityKey) ||
    !positive(value.unitId) ||
    !positive(value.crewType) ||
    !positive(value.amount)
  )
    return null;
  return {
    requestId: raw.requestId,
    payload: { cityKey: value.cityKey, unitId: value.unitId, crewType: value.crewType, amount: value.amount },
  };
}

export function forgetAllocation(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  request: AllocationRequest,
): boolean {
  const saved = readAllocation(storage, key);
  if (!saved) return true;
  if (
    saved.requestId !== request.requestId ||
    Object.entries(request.payload).some(([field, value]) => saved.payload[field as keyof Allocation] !== value)
  )
    return false;
  storage.removeItem(key);
  return true;
}

type Limits = {
  targets: Array<Pick<VisibleCityResources['targets'][number], 'id' | 'crewType' | 'capacity' | 'commanded'>>;
  resources: { garrison: Array<Pick<VisibleCityResources['resources']['garrison'][number], 'crewType' | 'troops'>> };
};
export function allocationLimit(board: Limits, unitId: number, crewType: number): number {
  const unit = board.targets.find((entry) => entry.id === unitId);
  const source = board.resources.garrison.find((entry) => entry.crewType === crewType);
  return !unit || unit.crewType !== crewType || !source
    ? 0
    : Math.max(0, Math.min(source.troops, unit.capacity - unit.commanded));
}
