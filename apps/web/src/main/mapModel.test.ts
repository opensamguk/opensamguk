import { describe, expect, it } from 'vitest';
import type { PublicGeography } from '@opensamguk/shared';
import { buildMapModel, describeSite, mapLabel } from './mapModel';

// INT-27 1단계: SVG 지도와 3D 지도가 같이 쓰는 거점 설명.
const map = {
  sites: [
    { id: 'luoyang', name: '낙양', kind: 'CITY', position: { x: 100, y: 100 }, anchorKey: 1 },
    { id: 'hulao', name: '호뢰관', kind: 'PASS', position: { x: 120, y: 100 }, anchorKey: 2 },
    { id: 'port', name: '맹진', kind: 'PORT', position: { x: 100, y: 90 }, parentCityId: 'luoyang' },
  ],
  routes: [],
} as unknown as PublicGeography;
const cities = [
  { key: 1, name: '낙양', kind: 'CITY', x: 100, y: 100, nationId: 7, level: 7, regionName: '중원' },
  { key: 2, name: '호뢰관', kind: 'PASS', x: 120, y: 100, nationId: null, supplied: false },
] as never;
const nations = [{ id: 7, name: '동탁', color: '#555555', capitalCityKey: 1 }] as never;
const generals = [{ id: 1, name: '여포', cityKey: 1, nationId: 7, portraitId: null, isHuman: false }] as never;

describe('mapModel', () => {
  const model = buildMapModel({ map, cities, nations, generals });

  it('물길이 없는 항구는 그리지 않고 도시·관문만 고르기 대상으로 둔다', () => {
    expect(model.drawnSites.map((site) => site.id)).toEqual(['luoyang', 'hulao']);
    expect(model.anchors.map((site) => site.id)).toEqual(['luoyang', 'hulao']);
    expect(mapLabel(model)).toBe('중원 지도, 도시 1개, 관문 1개');
  });

  it('읽기 이름은 이름·규모·지역·소속·수도·내 위치·장수 수 순이다', () => {
    const view = describeSite(model, map.sites[0]!, { myCityKey: 1, selectedKey: 1 });
    expect(view.label).toMatch(/^낙양, .+ 도시, 중원, 동탁, 수도, 내 위치, 장수 1명$/);
    expect(view.mine).toBe(true);
    expect(view.selected).toBe(true);
    expect(view.notes).toEqual(['수도', '내 위치']);
  });

  it('주인 없는 관문은 공백지이고 보급이 끊겨도 소속이 없으면 끊김을 붙이지 않는다', () => {
    const view = describeSite(model, map.sites[1]!, { myCityKey: null, selectedKey: null });
    expect(view.owner).toBe('공백지');
    expect(view.label).toBe('호뢰관, 관문, 공백지');
    expect(view.plate).toBe('호뢰관');
  });
});
