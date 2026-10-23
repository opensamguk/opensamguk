import type { MapCity } from '../game/types';

// 영토 재생의 응답 모양 (T4-35 계약, nations는 T4-56 프레임 조회). 그리는 부품이 서버 타입 없이 돌도록 지역 타입으로 둔다.
// 실제 응답 타입이 여기에 할당되는지는 TimelapsePanel.tsx의 satisfies가 묶어 계약이 바뀌면 타입 검사가 깨진다.
export interface FrameCity {
  cityKey: number;
  nationId: number | null;
}
export interface StoredNation {
  id: number;
  name: string;
  color: string;
}
export interface TimelapseFrame {
  tick: number;
  year: number;
  month: number;
  cities: readonly FrameCity[];
  // 그 달 정산 때 저장된 국가 이름·색. 그 프레임 도시 소유에 나오는 국가만 온다.
  nations: readonly StoredNation[];
}
export interface TimelapsePage {
  items: readonly TimelapseFrame[];
  nextCursor: string | null;
}

// 프레임 하나에서 국가 하나를 무엇으로 그릴지. 값은 그 프레임에 저장된 것만 쓴다 (docs/plans/T4-36.md 2.3).
export type FrameNation =
  { kind: 'empty' } | { kind: 'stored'; id: number; name: string; color: string } | { kind: 'missing'; id: number };

// 과거 표시값의 출처. 보존 계약이 정해지면 그 응답 필드에 묶은 구현 하나를 넘긴다.
// 지금 국가 행 값(currentNations)으로 만들지 않는다.
export interface NationDisplaySource {
  resolve(frameTick: number, nationId: number | null): FrameNation;
}

export type JoinedFrames =
  { ok: true; frames: TimelapseFrame[] } | { ok: false; frames: TimelapseFrame[]; error: 'order' | 'cursor' };

// 페이지를 잇는다. 오름차순과 cursor가 계약과 다르면 정렬해서 덮지 않고 그 앞까지만 내고 오류를 알린다.
export function joinPages(pages: readonly TimelapsePage[]): JoinedFrames {
  const frames: TimelapseFrame[] = [];
  for (const [i, page] of pages.entries()) {
    for (const frame of page.items) {
      const last = frames.at(-1);
      if (last && frame.tick <= last.tick) return { ok: false, frames, error: 'order' };
      frames.push(frame);
    }
    if (page.nextCursor === null) {
      if (i < pages.length - 1) return { ok: false, frames, error: 'cursor' };
      continue;
    }
    const last = page.items.at(-1);
    if (!last || page.nextCursor !== String(last.tick)) return { ok: false, frames, error: 'cursor' };
  }
  return { ok: true, frames };
}

// 지도 도시 하나의 이 달 모습. nation이 null이면 프레임에 그 도시가 없다.
export interface FrameCityView {
  city: MapCity;
  nation: Exclude<FrameNation, { kind: 'missing' }> | null;
}
export interface LegendEntry {
  nation: StoredNation;
  count: number;
}
export type FrameView =
  | { kind: 'missing'; nationIds: number[] }
  | { kind: 'ok'; cities: FrameCityView[]; offMap: number; legend: LegendEntry[]; empty: number };

// 지도 좌표와 프레임 소유를 잇는다. 지도에서는 이름·좌표·연결만 쓰고 지금 소유·규모·보급은 쓰지 않는다.
// 소유 국가 하나라도 저장값이 없으면 자료 오류라 그 프레임 전체를 그리지 않는다.
export function frameView(frame: TimelapseFrame, map: readonly MapCity[], source: NationDisplaySource): FrameView {
  const owners = new Map<number, FrameNation>();
  const missing: number[] = [];
  const byKey = new Map<number, FrameCity>();
  for (const entry of frame.cities) {
    byKey.set(entry.cityKey, entry);
    if (entry.nationId === null || owners.has(entry.nationId)) continue;
    const nation = source.resolve(frame.tick, entry.nationId);
    owners.set(entry.nationId, nation);
    if (nation.kind === 'missing') missing.push(entry.nationId);
  }
  if (missing.length > 0) return { kind: 'missing', nationIds: missing.sort((a, b) => a - b) };

  const mapKeys = new Set(map.map((city) => city.key));
  const offMap = frame.cities.filter((entry) => !mapKeys.has(entry.cityKey)).length;
  const counts = new Map<number, LegendEntry>();
  let empty = 0;
  const cities = map.map((city): FrameCityView => {
    const entry = byKey.get(city.key);
    if (!entry) return { city, nation: null };
    if (entry.nationId === null) {
      empty += 1;
      return { city, nation: { kind: 'empty' } };
    }
    const nation = owners.get(entry.nationId);
    if (nation?.kind !== 'stored') return { city, nation: { kind: 'empty' } };
    const legend = counts.get(nation.id);
    if (legend) legend.count += 1;
    else counts.set(nation.id, { nation: { id: nation.id, name: nation.name, color: nation.color }, count: 1 });
    return { city, nation };
  });
  const legend = [...counts.values()].sort((a, b) => b.count - a.count || a.nation.id - b.nation.id);
  return { kind: 'ok', cities, offMap, legend, empty };
}

export const frameDate = (frame: Pick<TimelapseFrame, 'year' | 'month'>) => `${frame.year}년 ${frame.month}월`;
