import type { WorldView } from '../model/world';

export function frontier(view: WorldView, nationId: number, cityKey: number) {
  return view.cities[cityKey]!.connections.some((key) => view.cities[key]?.nationId !== nationId);
}
