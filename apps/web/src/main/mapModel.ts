// 지도 모형 (INT-27 1단계, D-089). SVG 지도와 3D 지도가 같은 거점 설명·읽기 이름·풍선 내용을 쓰도록 한곳에 둔다.
// 그리기(SVG 표식, 3D 모형)는 각 지도가 하고, 무엇을 보이고 읽힐지는 여기서 정한다.
import type { PublicGeography } from '@opensamguk/shared';
import type { MapCity } from '../game/types';
import { generalsByCity, type MapGeneral } from './mapGeneralList';
import { CAPITAL_MARK, isCapital, levelName, type DrawnNation } from './siteMarkers';

export type MapSite = PublicGeography['sites'][number];
export type ModelCity = Pick<MapCity, 'key' | 'name' | 'kind' | 'x' | 'y' | 'nationId' | 'ruin'> & {
  regionName?: string | null | undefined;
  /** 지역 번호(삼10 지도 1~16). 3D 모형의 지역 색에 쓴다. */
  region?: number | undefined;
  supplied?: boolean;
  recorded?: boolean;
  level?: number;
};

export const SITE_KIND_LABELS = { CITY: '도시', PASS: '관문', PORT: '항구 시설', FIELD: '전장 표시' } as const;
// 풍선 오른쪽 위의 한 글자 표기. 도시는 규모(특·대·중·소 …)를 쓴다.
export const SITE_SHORT_LABELS = { CITY: '도시', PASS: '관', PORT: '항', FIELD: '전장' } as const;

export type MapModel = ReturnType<typeof buildMapModel>;

export function buildMapModel({
  map,
  cities,
  nations,
  generals,
}: {
  map: PublicGeography;
  cities: readonly ModelCity[];
  nations: readonly DrawnNation[];
  generals?: readonly MapGeneral[] | undefined;
}) {
  const cityByKey = new Map(cities.map((city) => [city.key, city]));
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  // 항구는 켜진 물길이 타고 내리는 자리일 때만 그린다. 물길이 없는 판(SAN10)의 항구 시설은 숨긴다.
  const usedPorts = new Set(
    map.routes.flatMap((route) => (route.enabled && route.mode === 'RIVER' ? (route.portIds ?? []) : [])),
  );
  return {
    cityByKey,
    nationById,
    siteById,
    generalsAt: generalsByCity(generals),
    drawnSites: map.sites.filter((site) => site.kind !== 'PORT' || usedPorts.has(site.id)),
    anchors: map.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS'),
  };
}

export type SiteView = {
  site: MapSite;
  city: ModelCity | undefined;
  nation: DrawnNation | undefined;
  parent: MapSite | undefined;
  grade: string | undefined;
  capital: boolean;
  mine: boolean;
  selected: boolean;
  /** 이름판 글자. 수도 표시와 폐허를 붙인다. */
  plate: string;
  /** 소속 글자. 기록이 없으면 기록 없음, 주인이 없으면 공백지다. 거점이 도시·관문이 아니면 null. */
  owner: string | null;
  /** 풍선 아래 줄들(수도, 소속, 내 위치, 폐허, 보급 끊김). */
  notes: string[];
  /** 화면 낭독 이름. 풍선·이름판과 같은 정보를 한 줄로 읽는다. */
  label: string;
};

export function describeSite(
  model: MapModel,
  site: MapSite,
  { myCityKey, selectedKey }: { myCityKey: number | null; selectedKey: number | null },
): SiteView {
  const city = site.anchorKey === undefined ? undefined : model.cityByKey.get(site.anchorKey);
  const nation = city?.nationId == null ? undefined : model.nationById.get(city.nationId);
  const mine = city !== undefined && city.key === myCityKey;
  const selected = city !== undefined && city.key === selectedKey;
  const parent = site.kind === 'PORT' ? model.siteById.get(site.parentCityId!) : undefined;
  const grade = site.kind === 'CITY' ? levelName(city?.level) : undefined;
  const capital = city !== undefined && isCapital(city, nation);
  const owner = city?.recorded === false ? '기록 없음' : (nation?.name ?? (city ? '공백지' : null));
  const cut = city?.supplied === false && city.nationId !== null;
  const notes = [
    capital ? '수도' : null,
    parent ? `${parent.name} 소속` : null,
    mine ? '내 위치' : null,
    city?.ruin ? `폐허 복구 ${city.ruin.percent}%` : null,
    cut ? '보급 끊김' : null,
  ].filter((note): note is string => note !== null);
  const generalCount = city ? (model.generalsAt.get(city.key)?.length ?? 0) : 0;
  const label = [
    site.name,
    grade ? `${grade} ${SITE_KIND_LABELS[site.kind]}` : SITE_KIND_LABELS[site.kind],
    city?.regionName ?? null,
    owner,
    capital ? '수도' : null,
    parent ? `${parent.name} 소속` : null,
    mine ? '내 위치' : null,
    city?.ruin ? `폐허 복구 ${city.ruin.percent}%` : null,
    cut ? '보급 끊김' : null,
    // 풍선(aria-hidden)의 장수 얼굴·이름과 같은 정보를 장수 수로 읽게 한다.
    generalCount ? `장수 ${generalCount}명` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    site,
    city,
    nation,
    parent,
    grade,
    capital,
    mine,
    selected,
    plate: `${capital ? CAPITAL_MARK : ''}${site.name}${city?.ruin ? ' (폐허)' : ''}`,
    owner,
    notes,
    label,
  };
}

/** 지도 전체의 읽기 이름. 도시·관문 수를 함께 읽는다. */
export function mapLabel(model: MapModel, prefix = '중원 지도') {
  const cities = model.anchors.filter((site) => site.kind === 'CITY').length;
  const passes = model.anchors.filter((site) => site.kind === 'PASS').length;
  return `${prefix}, 도시 ${cities}개, 관문 ${passes}개`;
}

// 지도 거점 고르기의 소속 구분 (INT-25, 원작 현재 도시 화면의 도시선택 `본국`·`타국`·`공백지`).
export type ChooserTag = '본국' | '타국' | '공백지' | '기록 없음';
const CHOOSER_ORDER: readonly ChooserTag[] = ['본국', '타국', '공백지', '기록 없음'];

export function chooserTag(
  city: Pick<ModelCity, 'nationId' | 'recorded'> | undefined,
  myNationId: number | null,
): ChooserTag {
  if (!city || city.recorded === false) return '기록 없음';
  if (city.nationId === null) return '공백지';
  return myNationId !== null && city.nationId === myNationId ? '본국' : '타국';
}

// 거점을 소속별로 묶는다. 본국을 먼저 두고 묶음 안에서는 지도 자료 순서를 지킨다. 빈 묶음은 뺀다.
export function chooserGroups<T extends { anchorKey?: number | undefined }>(
  anchors: readonly T[],
  cityByKey: ReadonlyMap<number, Pick<ModelCity, 'nationId' | 'recorded'>>,
  myNationId: number | null,
): Array<{ tag: ChooserTag; sites: T[] }> {
  return CHOOSER_ORDER.map((tag) => ({
    tag,
    sites: anchors.filter(
      (site) =>
        chooserTag(site.anchorKey === undefined ? undefined : cityByKey.get(site.anchorKey), myNationId) === tag,
    ),
  })).filter((group) => group.sites.length > 0);
}
