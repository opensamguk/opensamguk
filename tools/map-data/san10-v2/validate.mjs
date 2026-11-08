// 지도·시나리오·휘하를 저장소 규칙 코드로 검사한다. 저장소 루트에서 pnpm exec tsx로 실행한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { validateScenario } from '../../../packages/rules/src/world/validate/scenario';
import { validateMap } from '../../../packages/rules/src/world/validate/map';
import { buildRetinueHierarchy } from '../../../packages/rules/src/campaign/retinue';
import { S as ROOT, RETINUE_CHECK } from './paths.mjs';
const S = `${ROOT}/data`;
const { map, scenarios } = JSON.parse(readFileSync(`${S}/draft2.json`, 'utf8'));
const mr = validateMap(map, { scenarios: [] });
const perScenario = scenarios.filter((sc) => validateMap(map, { scenarios: [sc] }).status === 'pass').length;
let bad = 0,
  warn = 0;
const codes = {};
for (const sc of scenarios) {
  const r = validateScenario(sc, { map });
  const e = r.issues.filter((i) => i.severity !== 'warning');
  warn += r.issues.length - e.length;
  for (const i of r.issues) codes[i.code] = (codes[i.code] ?? 0) + 1;
  if (e.length) {
    bad++;
    console.log(
      sc.id,
      e
        .slice(0, 3)
        .map((x) => x.code + JSON.stringify(x.params ?? {}))
        .join(' ')
        .slice(0, 240),
    );
  }
}
const ret = JSON.parse(readFileSync(RETINUE_CHECK, 'utf8'));
let retBad = 0,
  overCap = 0,
  links = 0,
  maxDepth = 0;
const fails = [];
for (const s of ret) {
  const people = s.officers
    .filter((o) => o.nation >= 0)
    .map((o) => {
      const per = Math.min(100, Math.floor((o.cost * 50) / 5));
      return {
        id: o.id,
        worldId: 'w',
        nationId: o.nation + 1,
        stats: { leadership: per, strength: per, intel: per, politics: per, charm: per, source: 'draft' },
      };
    });
  const ids = new Set(people.map((p) => p.id));
  const ls = s.officers
    .filter((o) => o.nation >= 0 && o.master && ids.has(o.master))
    .map((o) => ({
      masterId: o.master,
      personId: o.id,
      relation: { S: 'STAFF', L: 'LIEUTENANT', G: 'GUEST' }[o.rel] ?? 'STAFF',
    }));
  links += ls.length;
  try {
    const h = buildRetinueHierarchy(people, ls);
    for (const p of people) if (!h.withinCapacity(p.id, 30)) overCap++;
    const par = new Map(ls.map((l) => [l.personId, l.masterId]));
    for (const p of people) {
      let d = 0,
        c = p.id;
      while (par.has(c) && d < 200) {
        c = par.get(c);
        d++;
      }
      maxDepth = Math.max(maxDepth, d);
    }
  } catch (e) {
    retBad++;
    fails.push(`${s.id}:${String(e).slice(0, 80)}`);
  }
}
const out = {
  mapStatus: mr.status,
  mapIssues: mr.issues.length,
  mapCodes: mr.issues.slice(0, 5).map((i) => i.code),
  scenarios: scenarios.length,
  mapPassWithScenario: perScenario,
  withErrors: bad,
  warnings: warn,
  codes,
  retinueScenarios: ret.length,
  retinueLinks: links,
  retinueFail: retBad,
  overCap,
  maxDepth,
  fails: fails.slice(0, 5),
};
console.log(JSON.stringify(out));
writeFileSync(`${S}/validate3.json`, JSON.stringify(out));
