import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import { retryUnlessClientError } from '../game/errors';
import { serverMessage } from '../turns/apiError';
import type { CityChoices } from '../turns/CommandPicker';
import { TRADE_COMMAND_KEY } from './contract';

// 기능이 없는 월드에 남은 편집기는 빈 후보와 이유를 표시한다.
export const TRADE_UNSUPPORTED: CityChoices = {
  options: [],
  note: '교역 조항을 아직 지원하지 않아 교역할 도시를 고를 수 없습니다.',
};

// 후보와 거부 이유는 서버가 계산한다. 목록에 교역이 있을 때만 조회한다.
export function useTradeCityChoices(worldId: string, hasTrade: boolean) {
  const trpc = useTRPC();
  const targets = useQuery({
    ...trpc.treaty.tradeTargets.queryOptions({ worldId }),
    enabled: hasTrade,
    retry: retryUnlessClientError,
    refetchInterval: 10_000,
  });
  return useCallback(
    (commandKey: string): CityChoices | null =>
      hasTrade && commandKey === TRADE_COMMAND_KEY
        ? {
            options: targets.data?.items.map((row) => ({ key: row.cityKey, name: row.cityName })) ?? [],
            note: targets.data
              ? targets.data.blocked
              : targets.isError
                ? (serverMessage(targets.error) ?? '교역 대상을 불러오지 못했습니다.')
                : '교역 대상 조회 중',
          }
        : null,
    [hasTrade, targets.data, targets.isError, targets.error],
  );
}
