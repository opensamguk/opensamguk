import type { WorldState } from './model/world';

// 소유권·수도 변경 직후 표시만 갱신한다. 월간 손해는 settleSupply에서 한 번만 적용한다.
export function refreshSupply(state: WorldState): void {
  const supplied = new Set<number>();
  for (const nation of Object.values(state.nations).sort((a,b) => a.id-b.id)) {
    const capital = state.cities[nation.capitalCityKey];
    if (capital?.nationId !== nation.id) continue;
    const queue = [capital.cityKey];
    supplied.add(capital.cityKey);
    for (let i = 0; i < queue.length; i++) {
      for (const id of [...state.cities[queue[i]!]!.connections].sort((a,b) => a-b)) {
        if (supplied.has(id) || state.cities[id]?.nationId !== nation.id) continue;
        supplied.add(id); queue.push(id);
      }
    }
  }
  for (const city of Object.values(state.cities)) city.supplied = supplied.has(city.cityKey);
}
