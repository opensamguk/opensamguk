import { describe, expect, it } from 'vitest';
import { cityGrade, cityLandSlots } from '@opensamguk/shared';
import { castleLayout } from './castleGeometry';
import {
  MOVES,
  advance,
  personBand,
  personInFront,
  populate,
  roadNet,
  route,
  walkerAt,
  type LifeSlot,
} from './cityLife';
import { slotBand } from './CityScene';
import { artLevel } from './slotArt';
import { talkTo, type TalkPack } from './cityTalk';
import { devLand } from './DevCastlePage';
import buyeo from './cityTalk/east-buyeo.json';
import central from './cityTalk/central.json';

function city(level: number) {
  const land = devLand(level, 2);
  const layout = castleLayout(cityGrade('CITY', level), land.slots);
  const slots: LifeSlot[] = layout.slots.map((s) => {
    const row = land.slots.find((slot) => slot.id === s.id)!.building!;
    return { id: s.id, a: s.a, b: s.b, zone: s.zone, building: row.building, level: 2, pending: false };
  });
  return { layout, slots };
}

describe('성 화면 사람', () => {
  it('걷는 사람은 길망을 따라가고 건물 받침 안으로 들어가지 않는다', () => {
    for (const level of [4, 5, 6, 7, 8, 9]) {
      const { layout, slots } = city(level);
      const life = populate(layout, slots, { style: 'central', terrain: 'forest', conds: ['battle', 'boom'] });
      expect(life.walkers.length).toBeGreaterThan(5);
      for (let t = 0; t < 1500; t++)
        for (const w of life.walkers) {
          advance(w, life.net, life.fronts);
          if (t % 5) continue;
          const p = walkerAt(w);
          const inside = slots.find(
            (s) => p.i > s.a + 0.01 && p.i < s.a + 2.99 && p.j > s.b + 0.01 && p.j < s.b + 2.99,
          );
          expect(inside, `${level} ${w.kind} ${p.i},${p.j}`).toBeUndefined();
        }
    }
  }, 30000);

  it('종류마다 다닐 곳을 지킨다: 아낙과 아이는 성 안, 사냥꾼과 소는 성 밖', () => {
    const { layout, slots } = city(7);
    const life = populate(layout, slots, { style: 'east-okjeo-ye', terrain: 'forest', conds: [] });
    life.walkers.push({
      kind: 'ox',
      path: [life.net.pts[life.net.edge[0]!]!],
      speed: 0.004,
      s: 0,
      loop: false,
      home: life.net.edge[0]!,
      at: life.net.edge[0]!,
      rest: 0,
      seed: 11,
    });
    const seenOut = new Set<string>();
    for (let t = 0; t < 6000; t++)
      for (const w of life.walkers) {
        advance(w, life.net, life.fronts);
        if (w.loop || t % 7) continue;
        const p = walkerAt(w);
        const inCastle = p.i > 0 && p.i < layout.inner && p.j > 0 && p.j < layout.inner;
        const area = w.area ?? MOVES[w.kind]?.area;
        if (area === 'inside') expect(inCastle, `${w.kind} ${p.i},${p.j}`).toBe(true);
        if (area === 'outside') expect(inCastle, `${w.kind} ${p.i},${p.j}`).toBe(false);
        if (!inCastle && !w.area) seenOut.add(w.kind);
      }
    expect(seenOut.has('villager')).toBe(true);
    expect(seenOut.has('woman')).toBe(false);
  }, 30000);

  it('시설을 지으면 그 시설 사람이 나온다(나루에는 뱃사람, 마구간에는 말)', () => {
    const { layout, slots } = city(7);
    const out = slots.filter((s) => s.zone === 'outside');
    for (const s of out) s.building = 'palisade';
    out[0]!.building = 'ferry';
    out[0]!.level = 3;
    out[1]!.building = 'stable';
    out[1]!.level = 2;
    const life = populate(layout, slots, { style: 'central', terrain: 'river', conds: [] });
    const ferry = life.walkers.filter((w) => w.work === 'ferry').map((w) => w.kind);
    expect(ferry[0]).toBe('fisher');
    expect(ferry.length).toBe(4);
    expect(life.walkers.find((w) => w.role === 'ferry')?.kind).toBe('fisher');
    expect(life.walkers.filter((w) => w.kind === 'horse' && w.area === 'outside').length).toBeGreaterThanOrEqual(2);
  });

  it('성벽은 성문으로만 지난다', () => {
    const { layout } = city(7);
    const net = roadNet(layout);
    for (const [a, list] of net.next.entries())
      for (const b of list)
        if (net.inside[a] !== net.inside[b])
          expect(net.gates.some((g) => (g.inner === a && g.outer === b) || (g.inner === b && g.outer === a))).toBe(
            true,
          );
    const r = route(net, net.gates[0]!.outer, net.gates[0]!.inner, 'both');
    expect(r).toEqual([net.gates[0]!.outer, net.gates[0]!.inner]);
    expect(route(net, net.gates[0]!.outer, net.gates[0]!.inner, 'inside')).toBeNull();
  });

  it('성 안 사람은 성벽 사이 띠, 성벽 너머는 앞이나 뒤 띠에 선다', () => {
    const { layout } = city(7);
    expect(personBand(layout, { i: 0.5, j: 4.5 })).toBe('inside');
    expect(personBand(layout, { i: layout.inner + 1.5, j: 4.5 })).toBe('front');
    expect(personBand(layout, { i: -1.5, j: 4.5 })).toBe('behind');
    const s = layout.slots.find((t) => t.zone === 'inside')!;
    expect(slotBand(layout, s)).toBe('inside');
    expect(personInFront({ i: s.a + 3.5, j: s.b + 1 }, s)).toBe(true);
    expect(personInFront({ i: s.a - 0.5, j: s.b + 1 }, s)).toBe(false);
  });

  it('땅 슬롯은 서버 슬롯과 같은 수다', () => {
    expect(city(9).layout.slots.length).toBe(cityLandSlots('CITY', 9).length);
  });
});

describe('슬롯 그림 단계', () => {
  it('용량의 1/3, 2/3에서 단계가 오른다', () => {
    expect(artLevel('farm', 0)).toBe(1);
    expect(artLevel('farm', 34)).toBe(2);
    expect(artLevel('farm', 70)).toBe(3);
    // 서버가 준 시설 상한으로 나눈다(큰 장터 상한 300).
    expect(artLevel('grand_market', 150, 300)).toBe(2);
    expect(artLevel('grand_market', 150)).toBe(3);
  });
});

describe('성 화면 대사', () => {
  const world = {
    season: 'spring' as const,
    water: false,
    conds: [],
    ctx: { ruler: '조조', taesu: '순욱', enemy: '원소', generals: [] },
  };
  it('양식 꾸러미의 말만 한다(공통 대사 없음)', () => {
    const pack = buyeo as unknown as TalkPack;
    const all = new Set(
      JSON.stringify(buyeo)
        .match(/"[^"]{4,}"/g)!
        .map((x) => x.slice(1, -1)),
    );
    let seen = 0;
    for (let n = 0; n < 200; n++) {
      let k = n * 7919;
      const rnd = () => ((k = (k * 16807) % 2147483647) % 1000) / 1000;
      const said = talkTo(pack, { kind: n % 2 ? 'villager' : 'soldier' }, world, rnd);
      expect(said.text.length).toBeGreaterThan(0);
      // 말끝 바꾸기, 이름 채우기 앞의 원문이 꾸러미에 있다
      if ([...all].some((line) => said.text.includes(line.slice(0, 8)))) seen++;
    }
    expect(seen).toBeGreaterThan(150);
  });

  it('공사 일꾼은 그 건물 공사 대사를 한다', () => {
    const pack = central as unknown as TalkPack;
    const said = talkTo(pack, { kind: 'worker', building: 'market' }, world);
    expect(said.text).toBe(pack.build.market!.during);
  });
});
