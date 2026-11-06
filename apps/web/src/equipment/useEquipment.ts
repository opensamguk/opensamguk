import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { retryUnlessClientError } from '../game/errors';
import { useTRPC } from '../trpc';

export type EquipmentBoard = inferRouterOutputs<AppRouter>['equipment']['mine'];
export type EquipmentRead =
  { kind: 'loading' } | { kind: 'error'; retry: () => void } | { kind: 'ready'; data: EquipmentBoard };
export const EQUIPMENT_SLOTS = [
  { key: 'horse', label: '명마' },
  { key: 'weapon', label: '무기' },
  { key: 'book', label: '서적' },
] as const;
export const EQUIPMENT_STATS = { leadership: '통솔', strength: '무력', intel: '지력' } as const;

export function useEquipment(
  worldId: string,
  enabled: boolean,
  generalId: number | undefined,
): EquipmentRead | undefined {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.equipment.mine.queryOptions({ worldId }),
    enabled: enabled && generalId !== undefined,
    retry: retryUnlessClientError,
  });
  if (!enabled) return undefined;
  if (query.isError)
    return {
      kind: 'error',
      retry: () => {
        void query.refetch();
      },
    };
  if (!query.data || query.data.generalId !== generalId) return { kind: 'loading' };
  return { kind: 'ready', data: query.data };
}
