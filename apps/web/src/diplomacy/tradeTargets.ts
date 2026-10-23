import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import type { CityChoices } from '../turns/CommandPicker';
import { TRADE_COMMAND_KEY, treatyApi, treatyQueryKey, type TradeTargets } from './contract';

// 예턴 편집의 교역 대상 고르기 (T2-08). 따로 저장하는 편집기를 두지 않고 30칸 편집기의 대상 도시 칸 후보만 바꾼다.
// 목록에 있어도 실행 때 엔진이 다시 검사한다. 목록이 비면 서버가 준 이유(blocked)를 칸 아래에 보인다.
export function tradeChoices(data: TradeTargets | undefined, failed: boolean): CityChoices {
  if (!data)
    return {
      options: [],
      note: failed ? '교역할 수 있는 도시를 불러오지 못했습니다.' : '교역할 수 있는 도시를 불러오는 중입니다.',
    };
  return {
    options: data.items.map((item) => ({
      key: item.cityKey,
      name: `${item.cityName} (${item.nation.name}, ${formatYearMonth(item.tradeEndsAt)}까지)`,
    })),
    note: data.items.length === 0 ? (data.blocked ?? '교역할 수 있는 도시가 없습니다.') : null,
  };
}

// 명령 목록에 교역이 있을 때만 묻는다. 교역 명령이 아직 없는 서버에서는 아무것도 바꾸지 않는다.
export function useTradeCityChoices(worldId: string, hasTrade: boolean) {
  const query = useQuery({
    queryKey: treatyQueryKey('tradeTargets', { worldId }),
    queryFn: () => treatyApi.tradeTargets.query({ worldId }),
    enabled: hasTrade,
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
  const { data, isError } = query;
  return useCallback(
    (commandKey: string) => (commandKey === TRADE_COMMAND_KEY ? tradeChoices(data, isError) : null),
    [data, isError],
  );
}
