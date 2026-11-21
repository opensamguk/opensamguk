// 현행 SAN10 191판과 새 지도 초안의 시뮬레이션 시간을 메모리에서 비교한다. 저장소 루트에서 pnpm exec tsx로 실행한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { composeInitialWorld } from '../../../apps/engine/src/world/resources';
import { simulateGame } from '../../../apps/engine/src/simulation';
import { S as ROOT } from './paths.mjs';
const S = `${ROOT}/data`;
const j = (p) => JSON.parse(readFileSync(p, 'utf8'));
const res = (kind, name, content) => ({ kind, name, version: 1, content, contentHash: 'x', source: 'perf' });
const unitSet = j('resources/unitset/expanded.json');
const statRules = j('resources/scenario/five-stats.json');
const base = {
  map: j('resources/map/san10.json'),
  scenario: j('resources/scenario/san10-191.json'),
  portrait: j('resources/portraits/191-map.json'),
};
const draft = j(`${S}/draft2.json`);
const data = j(`${S}/data2.json`);
const statBy = new Map(data.roster.filter((r) => r[8]).map((r) => [r[1], r[8]]));
function makeDraft(id) {
  const sc = draft.scenarios.find((s) => s.id === id);
  const placed = new Set(sc.general.map((g) => g[1]));
  const rest = data.roster.filter((r) => !placed.has(r[1]));
  const general = [
    ...sc.general,
    ...rest.map((r) => [
      1,
      r[1],
      `p/${r[0]}.jpg`,
      0,
      null,
      50,
      50,
      50,
      0,
      r[3] ?? 150,
      Math.max(r[4] ?? 300, r[3] ?? 150),
      '\uC720\uC9C0',
      null,
    ]),
  ];
  const seen = /* @__PURE__ */ new Map();
  for (const g of general) {
    const n = seen.get(g[1]) ?? 0;
    seen.set(g[1], n + 1);
    if (n) g[1] = `${g[1]}#${n}`;
  }
  const generalStats = general.map((g, i) => {
    const st = statBy.get(String(g[1]).split('#')[0]) ?? [50, 50, 50, 50, 50];
    const v = (k) => st[k];
    g[5] = v(0);
    g[6] = v(1);
    g[7] = v(2);
    return {
      generalId: i + 1,
      stats: { leadership: v(0), strength: v(1), intel: v(2), politics: v(3), charm: v(4) },
      sourceId: 'perf',
      sourceRevision: 'perf',
      officerId: 4e4 + i,
    };
  });
  const portraits = {};
  general.forEach((g, i) => {
    if (i < 1e3) portraits[g[1]] = 10001 + i;
  });
  return { scenario: { ...sc, id: 'draft', title: sc.title, generalStats, general }, portrait: { portraits } };
}
function run(label, map, scenario, portrait, years) {
  const t0 = performance.now();
  const init = composeInitialWorld(
    {
      map: res('MAP', map.id, map),
      scenario: res('SCENARIO', scenario.id, scenario),
      unitSet: res('UNIT_SET', unitSet.id, unitSet),
      statRules: res('STAT_RULES', 'default', statRules),
      portraitMap: res('PORTRAIT_MAP', 'p', portrait),
    },
    'perf-1',
  );
  const t1 = performance.now();
  const yearly = [];
  let last = performance.now();
  const out = simulateGame(init, {
    maxYear: init.startYear + years,
    convergence: false,
    onYear: () => {
      const n = performance.now();
      yearly.push(n - last);
      last = n;
    },
  });
  const t2 = performance.now();
  const row = {
    label,
    sites: map.sites.length,
    generals: scenario.general.length,
    composeMs: Math.round(t1 - t0),
    simMs: Math.round(t2 - t1),
    years: yearly.length,
    msPerYear: Math.round((t2 - t1) / Math.max(1, yearly.length)),
    result: out?.status ?? out?.endedAt ?? Object.keys(out ?? {}).slice(0, 4),
  };
  console.log(JSON.stringify(row));
  return row;
}
const rows = [];
const YEARS = Number(process.env.YEARS ?? 3);
rows.push(run('\uD604\uD589 SAN10 191 (155\uACF3, 491\uBA85)', base.map, base.scenario, base.portrait, YEARS));
const d = makeDraft('n04');
draft.map.id = 'san10-v2';
try {
  rows.push(run('\uC0C8 \uC9C0\uB3C4 200\uB144 (\uC804\uCCB4 \uBA85\uB2E8)', draft.map, d.scenario, d.portrait, YEARS));
} catch (e) {
  console.log('DRAFT FAIL', String(e).slice(0, 800));
}
writeFileSync(`${S}/perf.json`, JSON.stringify(rows));
