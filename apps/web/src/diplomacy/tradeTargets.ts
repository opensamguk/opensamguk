import { useCallback } from 'react';
import type { CityChoices } from '../turns/CommandPicker';
import { TRADE_COMMAND_KEY } from './contract';

// 예턴 편집의 교역 대상 고르기 (T2-08). 교역 조항과 교역 대상 조회는 서버에 아직 없다 (AppRouter treaty에 tradeTargets 없음).
// 그래서 묻지 않고 후보를 비운 채 이유를 보인다. 지도 도시나 빈 목록으로 꾸며 다른 대상을 고르게 하지 않는다.
export const TRADE_UNSUPPORTED: CityChoices = {
  options: [],
  note: '교역 조항을 아직 지원하지 않아 교역할 도시를 고를 수 없습니다.',
};

// 명령 목록에 교역이 있을 때만 대상 도시 칸을 바꾼다. 지금 서버 명령 목록에는 교역이 없다.
export function useTradeCityChoices(_worldId: string, hasTrade: boolean) {
  return useCallback(
    (commandKey: string) => (hasTrade && commandKey === TRADE_COMMAND_KEY ? TRADE_UNSUPPORTED : null),
    [hasTrade],
  );
}
