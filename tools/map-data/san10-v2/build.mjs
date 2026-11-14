import fs from 'node:fs';
import { NO_LIFE, LATE, LINEAGE, ABSORB } from './ledger.mjs';
import { IFS } from './ifs.mjs';
import { DIPLO } from './diplomacy.mjs';
import { verify } from './diplo-verify.mjs';
import { REPO as W, S, RETINUE_CHECK } from './paths.mjs';
const R = process.env.CORE2026_DIR;
if (!R) throw new Error('CORE2026_DIR에 core2026 저장소(c81d304) 경로를 지정하세요.');
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hsg = load(`${S}/data/hsg-clean.json`);
// 모드 실제 값: 시나리오별 도시 소유 표와 확장 인물 행(hsg_event_state의 CX44·OFX1)
const MODX = load(`${S}/data/mod-ext.json`);
const MODSTAT = { extRows: 0, extAdded: 0, renamed: [] };
{
  const FIXN = { 독발수기: '독발수기능', 아달라이: '아달라이사금' };
  const full = (n) => {
    if (FIXN[n]) return FIXN[n];
    if (n.length >= 4) {
      const c = hsg.dict.filter((x) => x.startsWith(n) && x !== n);
      if (c.length === 1) return c[0];
      if (n.endsWith('이사')) return n + '금';
    }
    return n;
  };
  for (const s of hsg.scen) {
    const m = MODX[s.file];
    if (!m) throw new Error('mod-ext 없음 ' + s.file);
    m.names.forEach((n, i) => {
      if (n !== hsg.cities[i][0]) throw new Error(`도시 이름 불일치 ${s.file} ${i} ${n} ${hsg.cities[i][0]}`);
    });
    s.own = m.own;
    s.xrows = m.rows.map((r) => {
      MODSTAT.extRows++;
      const nm = full(r[0]);
      if (nm !== r[0] && !MODSTAT.renamed.includes(`${r[0]}→${nm}`)) MODSTAT.renamed.push(`${r[0]}→${nm}`);
      return [nm, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]];
    });
  }
  console.log('MODX', JSON.stringify(MODSTAT));
}
const KLIN = {
  고국천왕: 'gog',
  산상왕: 'gog',
  동천왕: 'gog',
  중천왕: 'gog',
  서천왕: 'gog',
  위구태: 'by',
  간위거: 'by',
  마여: 'by',
  의려: 'by',
  초고왕: 'bj',
  구수왕: 'bj',
  고이왕: 'bj',
  아달라이사금: 'sr',
  벌휴이사금: 'sr',
  나해이사금: 'sr',
  조분이사금: 'sr',
  첨해이사금: 'sr',
  미추이사금: 'sr',
  수로왕: 'gy',
  거등왕: 'gy',
  마품왕: 'gy',
  히미코: 'wa',
  이요: 'wa',
  히미쿠코: 'guno',
};
const PNAME = { gog: '고구려', by: '부여', bj: '백제', sr: '신라', gy: '가야', wa: '왜', guno: '구노국' };
const REIGN = {
  gog: [
    [179, null],
    [197, '고국천왕'],
    [227, '산상왕'],
    [248, '동천왕'],
    [270, '중천왕'],
    [999, '서천왕'],
  ],
  by: [
    [230, '위구태'],
    [245, '간위거'],
    [285, '마여'],
    [999, '의려'],
  ],
  bj: [
    [214, '초고왕'],
    [234, '구수왕'],
    [999, '고이왕'],
  ],
  sr: [
    [185, '아달라이사금'],
    [196, '벌휴이사금'],
    [230, '나해이사금'],
    [247, '조분이사금'],
    [262, '첨해이사금'],
    [999, '미추이사금'],
  ],
  gy: [
    [199, '수로왕'],
    [253, '거등왕'],
    [999, '마품왕'],
  ],
  wa: [
    [248, '히미코'],
    [999, '이요'],
  ],
};
const san = load(`${W}/resources/map/san10.json`);
const basemap = load(`${W}/apps/web/src/main/san10-basemap.json`);
const roster = load(`${S}/roster-merged.json`);
const ext = load(`${S}/data/hsg-ext.json`);
const fixes = [];
const ne = load(`${W}/apps/web/src/mapEditor/geodata/natural-earth.json`);
const shiftPath = (d) =>
  d.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, x, y) => `${(+x).toFixed(1)},${(+y + 260).toFixed(1)}`);
const riverPaths = ne.rivers.map((r) => ({ name: r.name, d: shiftPath(r.path) }));

// ── 1. 지도 ─────────────────────────────────────────────
const ALIAS = {
  자동: '재동',
  무위: '서량',
  야마타이국: '야마대',
  건마국: '건마',
  구야국: '구야',
  대마국: '대마',
  목지국: '목지',
  백제국: '백제',
  사로국: '사로',
  이도국: '이도',
  일지국: '일지',
  지유국: '지유',
  투마국: '투마',
  불이: '불내',
  하동: '평양',
  남창: '예장',
  역경: '역현',
  구원: '오원',
};
const KEEP_SAN_NAME = new Set([
  '야마타이국',
  '건마국',
  '구야국',
  '대마국',
  '목지국',
  '백제국',
  '사로국',
  '이도국',
  '일지국',
  '지유국',
  '투마국',
]);
const modCities = hsg.cities.map(([name, x, y]) => ({ name, x, y }));
const modBy = new Map(modCities.map((c) => [c.name, c]));
const sanBy = new Map(san.sites.map((s) => [s.name, s]));
const pairs = [];
for (const c of modCities) {
  const s = sanBy.get(c.name);
  if (s) pairs.push([c, s]);
}
for (const [sn, mn] of Object.entries(ALIAS))
  if (sanBy.has(sn) && modBy.has(mn)) pairs.push([modBy.get(mn), sanBy.get(sn)]);
const solve = (A, b) => {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++)
      if (r !== i) {
        const f = M[r][i] / M[i][i];
        for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
      }
  }
  return M.map((r, i) => r[n] / r[i]);
};
const fit = (key) => {
  const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    b = [0, 0, 0];
  for (const [c, s] of pairs) {
    const v = [c.x, c.y, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j];
      b[i] += v[i] * s.position[key];
    }
  }
  return solve(A, b);
};
const fx = fit('x'),
  fy = fit('y');
const affine = (c) => [fx[0] * c.x + fx[1] * c.y + fx[2], fy[0] * c.x + fy[1] * c.y + fy[2]];
const anchors = pairs
  .map(([c, s]) => {
    const [x, y] = affine(c);
    return { c, dx: s.position.x - x, dy: s.position.y - y, r: Math.hypot(s.position.x - x, s.position.y - y) };
  })
  .filter((a) => a.r < 90);
const toCanvas = (c) => {
  const [x, y] = affine(c);
  let wx = 0,
    wy = 0,
    ws = 0;
  for (const a of anchors) {
    const d2 = (a.c.x - c.x) ** 2 + (a.c.y - c.y) ** 2;
    if (d2 < 1) return [x + a.dx, y + a.dy];
    const w = 1 / d2 ** 1.5;
    wx += w * a.dx;
    wy += w * a.dy;
    ws += w;
  }
  return [x + wx / ws, y + wy / ws];
};
const resid = pairs
  .map(([c, s]) => {
    const [x, y] = affine(c);
    return [Math.hypot(x - s.position.x, y - s.position.y), c.name];
  })
  .sort((a, b) => b[0] - a[0]);
console.log(
  'fit pairs',
  pairs.length,
  'rms',
  Math.sqrt(resid.reduce((n, r) => n + r[0] ** 2, 0) / resid.length).toFixed(1),
  'worst',
  resid
    .slice(0, 8)
    .map((r) => `${r[1]}:${r[0].toFixed(0)}`)
    .join(' '),
);
const landPolys = basemap.land.map((d) =>
  (d.match(/-?\d+\.?\d*,-?\d+\.?\d*/g) ?? []).map((p) => p.split(',').map(Number)),
);
const onLand = (x, y) => {
  let hit = 0;
  for (const poly of landPolys) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i],
        [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) hit++;
  }
  return hit > 0;
};

const sites = [];
const siteBy = new Map();
const add = (o) => {
  sites.push(o);
  siteBy.set(o.name, o);
  return o;
};
const mergedNote = [];
const conflicts = [];
const sanToMod = new Map(Object.entries(ALIAS));
for (const c of modCities) {
  const [x, y] = toCanvas(c);
  const aliasSan = [...sanToMod.entries()].find(([, m]) => m === c.name)?.[0];
  let sanSite = sanBy.get(c.name) ?? (aliasSan ? sanBy.get(aliasSan) : null);
  const [ax, ay] = affine(c);
  const conflict = sanSite && !aliasSan && Math.hypot(sanSite.position.x - ax, sanSite.position.y - ay) > 90;
  if (conflict) {
    sanSite = null;
    conflicts.push(c.name);
  }
  const name = conflict ? `${c.name}(모드)` : aliasSan && KEEP_SAN_NAME.has(aliasSan) ? aliasSan : c.name;
  // 공통 거점은 현행 게임 좌표를 유지한다(기존 지도와 도로를 살리기 위해), 모드 전용은 맞춘 좌표
  const pos = sanSite ? [sanSite.position.x, sanSite.position.y] : [x, y];
  add({
    name,
    modName: c.name,
    x: pos[0],
    y: pos[1],
    kind: sanSite?.kind === 'PASS' ? 'P' : 'C',
    level: sanSite?.level ?? 3,
    region: sanSite?.region ?? null,
    src: sanSite ? (aliasSan ? '통합' : '공통') : '모드',
    sanName: aliasSan ?? null,
  });
  if (aliasSan) mergedNote.push(`${aliasSan}=${c.name}`);
}
const REGNO = {
  사례: 1,
  예주: 2,
  기주: 3,
  연주: 4,
  서주: 5,
  청주: 6,
  형주: 7,
  양주: 8,
  익주: 9,
  량주: 11,
  병주: 12,
  유주: 13,
  교주: 14,
  마한: 15,
  진한: 15,
  변한: 15,
  '예맥·옥저': 15,
  '부여·고구려': 15,
  왜: 15,
  '선비·오환': 16,
};
const provOf = new Map();
for (const [r, v] of Object.entries(ext.regions)) for (const c of v.cities) provOf.set(c, r);
for (const s of sites) {
  const p = provOf.get(s.modName);
  s.prov = p ?? null;
  if (s.src === '모드' && p) s.region = REGNO[p] ?? s.region;
}
for (const s of sites)
  if (s.name === '서현') {
    s.prov = '량주';
    s.region = 11;
  }
const near = (x, y, skip) => {
  let best = null;
  for (const s of sites) {
    if (s.name === skip) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (!best || d < best[0]) best = [d, s];
  }
  return best;
};
const added = [],
  absorbed = [];
for (const s of san.sites) {
  if ((siteBy.has(s.name) && !conflicts.includes(s.name)) || sanToMod.has(s.name)) continue;
  const n = near(s.position.x, s.position.y);
  // 관문은 항상 살린다. 도시는 모드 도시와 7단위 안에 겹치면 같은 곳으로 친다.
  if (s.kind !== 'PASS' && n && n[0] < 3 && !['오장원', '정도', '석정', '장판', '진창', '계교'].includes(s.name)) {
    absorbed.push(`${s.name}→${n[1].name}`);
    n[1].sanName = s.name;
    mergedNote.push(`${s.name}=${n[1].name}`);
    continue;
  }
  add({
    name: s.name,
    modName: null,
    x: s.position.x,
    y: s.position.y,
    kind: s.kind === 'PASS' ? 'P' : 'C',
    level: s.level ?? 2,
    region: s.region,
    src: 'SAN10',
  });
  added.push(s.name);
}
// 전장: 진(2) 거점으로 넣는다(D-054·D-055). 이미 거점이 있는 곳과 전장이 아닌 곳은 그 거점의 설명으로만 남긴다.
const LL = (lon, lat) => [
  ((lon - basemap.bounds[0]) / (basemap.bounds[2] - basemap.bounds[0])) * san.canvas.width,
  ((basemap.bounds[3] - lat) / (basemap.bounds[3] - basemap.bounds[1])) * san.canvas.height,
];
const FIELDS = [
  ['오소', 114.05, 35.05, '200년 조조가 원소의 군량고를 불태운 곳.'],
  ['창정', 115.3, 35.9, '201년 조조가 원소 잔군을 격파한 황하 나루.'],
  ['박망파', 112.9, 33.1, '유비가 하후돈을 복병으로 물리친 곳.'],
  ['형양 변수', 113.4, 34.8, '190년 조조가 서영에게 패한 변수 가의 싸움터.'],
  ['양성', 112.9, 33.75, '191년 손견이 동탁군을 격파한 땅.'],
  ['현산', 112.2, 32.0, '192년 손견이 전사한 양양 남쪽 산.'],
  ['곽가 복양 성곽', 115.0, 35.75, '194~195년 조조와 여포가 맞붙은 복양 일대의 전장.'],
  ['육수', 112.5, 32.8, '197년 조조가 장수에게 패해 전위와 조앙을 잃은 곳.'],
  ['노수 나루', 118.0, 37.7, '조조가 원상을 쫓아 건넌 곳.'],
  ['백랑산 전장', 120.0, 41.3, '207년 조조가 오환을 격파한 유성 부근.'],
  ['위수 남안', 110.2, 34.5, '211년 조조가 마초·한수를 이간해 격파한 관중 전장.'],
  ['정군산', 106.65, 33.15, '219년 황충이 하후연을 벤 한중의 산.'],
  ['소요진', 117.3, 31.9, '215년 장료가 손권을 습격한 합비 나루.'],
  ['맥성', 111.9, 30.85, '219년 관우가 포위된 끝에 사로잡힌 성.'],
  ['효정', 111.4, 30.5, '222년 육손이 유비의 진영을 불태운 곳.'],
  ['동흥제', 117.7, 31.65, '252년 제갈각이 위군을 격파한 둑.'],
  ['상방곡', 107.5, 34.2, '234년 제갈량이 사마의를 불로 공격했다고 전하는 계곡.'],
  ['농서 단곡', 105.7, 34.7, '256년 등애가 강유를 크게 이긴 곳.'],
  ['음평 샛길', 105.0, 32.9, '263년 등애가 험로로 넘어 면죽으로 나온 길.'],
  ['고평릉', 112.55, 34.6, '249년 사마의가 조상의 틈을 노린 위 명제의 능.'],
  ['환도성', 126.15, 41.15, '209년 산상왕이 옮긴 산성. 244년 관구검에게 함락됐다.'],
  ['비류수', 125.5, 41.0, '246년까지 고구려와 위가 맞붙은 강변.'],
  ['양맥 골짜기', 125.0, 41.3, '동천왕이 위군을 한때 물리친 곳.'],
  ['기리영', 127.1, 37.9, '245년 삼한이 대방군을 습격한 영.'],
  ['구지봉', 128.87, 35.24, '가락국 건국 전승이 깃든 봉우리.'],
  ['대방 왜 뱃길', 129.0, 35.0, '비미호 사신이 대방으로 오간 대한해협 뱃길의 나루.'],
  ['마키무쿠', 135.85, 34.54, '야마타이국 기나이설의 근거 유적.'],
];
const FIELD_MERGE = {
  '백랑산 전장': '백랑산',
  '곽가 복양 성곽': '복양',
  마키무쿠: '야마타이국',
  구지봉: '구야국',
  '대방 왜 뱃길': '구야국',
};
const fieldSites = [];
for (const [name, lon, lat, desc] of FIELDS) {
  const into = FIELD_MERGE[name];
  if (into) {
    const t = siteBy.get(into);
    if (!t) throw new Error('merge target ' + into);
    t.note = [t.note, desc].filter(Boolean).join(' ');
    continue;
  }
  if (siteBy.has(name)) throw new Error('name clash ' + name);
  const [x, y] = LL(lon, lat);
  fieldSites.push(add({ name, modName: null, x, y, kind: 'C', level: 2, region: null, src: '전장', note: desc }));
}
const NATION_PROV = new Set(['마한', '진한', '변한', '예맥·옥저', '왜']);
const LEVEL_FIX = { 기춘: 2, 대방: 2, 포산: 5, 안평: 5, 낭중: 2, 울림: 2, 고: 2, 환현: 2 };
const D_DESC = new Map(JSON.parse(fs.readFileSync(`${S}/data/ai/D.json`, 'utf8')).map((x) => [x.name, x.desc]));
const levelLog = { 소: [], 진: [] };
for (const s of sites) {
  if (s.src !== '모드') continue;
  const text = hsg.desc[s.modName] ?? D_DESC.get(s.name) ?? '';
  const first = text.split(/[.。]/)[0];
  const isSeat = /^[가-힣]+ [가-힣]+(군|국)$/.test(first.trim());
  const level = LEVEL_FIX[s.name] ?? (NATION_PROV.has(s.prov) || isSeat ? 5 : 2);
  s.level = level;
  (level === 5 ? levelLog.소 : levelLog.진).push(s.name);
}
console.log('규모 소', levelLog.소.length, levelLog.소.join(' '));
console.log('규모 진', levelLog.진.length, levelLog.진.join(' '));
const ISLAND = new Set(['일지국', '대마국', '주호', '이주', '이도국', '말로국']);
const snapped = [];
for (const s of sites) {
  if (onLand(s.x, s.y) || ISLAND.has(s.name)) continue;
  let done = false;
  for (let r = 3; r <= 45 && !done; r += 3)
    for (let a = 0; a < 16 && !done; a++) {
      const x = s.x + r * Math.cos((a * Math.PI) / 8),
        y = s.y + r * Math.sin((a * Math.PI) / 8);
      if (onLand(x, y)) {
        s.x = x;
        s.y = y;
        done = true;
        snapped.push(s.name);
      }
    }
}
const home = new Map(sites.map((s) => [s.name, [s.x, s.y]]));
const MIN = 8.5,
  CAP = 12;
const closeBefore = [];
for (let i = 0; i < sites.length; i++)
  for (let j = i + 1; j < sites.length; j++)
    if (Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y) < MIN)
      closeBefore.push(`${sites[i].name}·${sites[j].name}`);
for (let it = 0; it < 80; it++) {
  let moved = false;
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i],
        c = sites[j];
      let dx = c.x - a.x,
        dy = c.y - a.y,
        dist0 = Math.hypot(dx, dy);
      if (dist0 >= MIN) continue;
      if (dist0 < 0.01) {
        dx = 1;
        dy = 0;
        dist0 = 1;
      }
      const push = (MIN - dist0) / 2 + 0.05;
      const ux = dx / dist0,
        uy = dy / dist0;
      a.x -= ux * push;
      a.y -= uy * push;
      c.x += ux * push;
      c.y += uy * push;
      moved = true;
    }
  for (const s of sites) {
    const [hx, hy] = home.get(s.name);
    const d0 = Math.hypot(s.x - hx, s.y - hy);
    if (d0 > CAP) {
      s.x = hx + ((s.x - hx) * CAP) / d0;
      s.y = hy + ((s.y - hy) * CAP) / d0;
    }
  }
  if (!moved) break;
}
const closeAfter = [];
for (let i = 0; i < sites.length; i++)
  for (let j = i + 1; j < sites.length; j++)
    if (Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y) < MIN - 0.2)
      closeAfter.push(`${sites[i].name}·${sites[j].name}`);
fixes.push({ snapped, closeBefore: closeBefore.length, closeAfter });
console.log(
  'snapped',
  snapped.join(' '),
  '| 겹침',
  closeBefore.length,
  '→',
  closeAfter.length,
  closeAfter.slice(0, 12).join(' '),
);
const offLand = sites.filter((s) => !onLand(s.x, s.y)).map((s) => s.name);
console.log(
  'sites',
  sites.length,
  'added',
  added.length,
  'absorbed',
  absorbed.join(' '),
  '| offLand',
  offLand.length,
  offLand.slice(0, 30).join(' '),
);
for (const s of sites)
  if (s.region == null) {
    let best = null;
    for (const t of sites) {
      if (t.region == null) continue;
      const d = Math.hypot(s.x - t.x, s.y - t.y);
      if (!best || d < best[0]) best = [d, t.region];
    }
    s.region = best ? best[1] : 1;
  }
for (const f of fieldSites) {
  let best = null;
  for (const t of sites) {
    if (!t.prov) continue;
    const d = Math.hypot(f.x - t.x, f.y - t.y);
    if (!best || d < best[0]) best = [d, t.prov];
  }
  f.prov = best ? best[1] : null;
}
// 도로: 현행 도로를 살리고 나머지는 상대 이웃 그래프로 잇는다
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const edges = new Map();
const idName = new Map(san.sites.map((s) => [s.id, s.name]));
const resolveSite = (n) =>
  siteBy.get(n)?.name ??
  (sanToMod.has(n)
    ? (siteBy.get(sanToMod.get(n))?.name ?? [...siteBy.values()].find((x) => x.modName === sanToMod.get(n))?.name)
    : null) ??
  [...siteBy.values()].find((x) => x.sanName === n)?.name ??
  null;
let keptRoads = 0;
for (const e of san.routes) {
  const a = resolveSite(idName.get(e.from)),
    b = resolveSite(idName.get(e.to));
  if (a && b && a !== b && !edges.has(edgeKey(a, b))) {
    edges.set(edgeKey(a, b), 'SAN10');
    keptRoads++;
  }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const landShare = (a, b) => {
  let ok = 0;
  const n = 12;
  for (let i = 0; i <= n; i++) if (onLand(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) ok++;
  return ok / (n + 1);
};
const GUAN = new Set(['위수 남안', '상방곡', '장안', '미현', '옹현', '칠현', '오장원', '진창', '화산', '기산']);
const gateOf = (s) =>
  s.region === 9 || s.region === 10
    ? 'shu'
    : s.region === 11
      ? 'liang'
      : GUAN.has(s.name)
        ? 'guan'
        : s.region === 12
          ? 'bing'
          : s.region === 14
            ? 'jiao'
            : s.region === 15
              ? 'east'
              : s.region === 16
                ? 'tribe'
                : 'plain';
const SEA = [
  ['구야국', '대마국'],
  ['대마국', '일지국'],
  ['일지국', '말로국'],
  ['말로국', '이도국'],
  ['이도국', '노국'],
  ['노국', '불미국'],
  ['모로비리', '주호'],
];
const EXTRA_ROADS = [
  ['하내', '낙양'],
  ['심양', '시상'],
  ['기춘', '강하'],
  ['주현', '강하'],
  ['강릉', '화용'],
  ['안정', '미현'],
  ['영주', '안정'],
  ['서안평', '낙랑'],
  ['옥저', '북옥저'],
  ['초팔', '다벌'],
  ['조문', '근기'],
  ['감문', '근기'],
  ['사벌', '감문'],
  ['대방', '백제국'],
  ['대방', '기리영'],
  ['동래', '북해'],
  ['금성', '서평'],
  ['금성', '적도'],
  ['영주', '북지'],
  ['북지', '안정'],
];
for (const [a, c] of EXTRA_ROADS) {
  if (siteBy.has(a) && siteBy.has(c)) edges.set(edgeKey(a, c), '보강');
  else console.log('ROAD?', a, c);
}
if (siteBy.has('동래') && siteBy.has('답씨')) edges.set(edgeKey('동래', '답씨'), '해로');
let seaAdded = 0;
for (const [a, c] of SEA)
  if (siteBy.has(a) && siteBy.has(c) && !edges.has(edgeKey(a, c))) {
    edges.set(edgeKey(a, c), '해로');
    seaAdded++;
  }
const BIG = /^(Yellow|Huang|Huang He|Yangtze|Chang Jiang|Jinsha)/i;
const riverLines = riverPaths
  .filter((r) => BIG.test(r.name ?? ''))
  .map((r) => (r.d.match(/-?\d+\.?\d*,-?\d+\.?\d*/g) ?? []).map((p) => p.split(',').map(Number)));
console.log(
  'rivers',
  riverPaths.length,
  'big',
  riverLines.length,
  [...new Set(riverPaths.map((r) => r.name))].slice(0, 60).join('|'),
);
const crossSeg = (a, c, p, q) => {
  const d1 = (q[0] - p[0]) * (a.y - p[1]) - (q[1] - p[1]) * (a.x - p[0]);
  const d2 = (q[0] - p[0]) * (c.y - p[1]) - (q[1] - p[1]) * (c.x - p[0]);
  const d3 = (c.x - a.x) * (p[1] - a.y) - (c.y - a.y) * (p[0] - a.x);
  const d4 = (c.x - a.x) * (q[1] - a.y) - (c.y - a.y) * (q[0] - a.x);
  return d1 * d2 < 0 && d3 * d4 < 0;
};
const crossesRiver = (a, c) => {
  for (const l of riverLines) for (let i = 1; i < l.length; i++) if (crossSeg(a, c, l[i - 1], l[i])) return true;
  return false;
};
let blockedRiver = 0;
let blockedGate = 0;
let gen = 0;
for (let i = 0; i < sites.length; i++)
  for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i],
      b = sites[j],
      d = dist(a, b);
    if (d > 95 || edges.has(edgeKey(a.name, b.name))) continue;
    let blocked = false;
    for (const c of sites) {
      if (c === a || c === b) continue;
      if (Math.max(dist(a, c), dist(b, c)) < d) {
        blocked = true;
        break;
      }
    }
    if (blocked || landShare(a, b) < 0.8) continue;
    if (gateOf(a) !== gateOf(b)) {
      blockedGate++;
      continue;
    }
    if (crossesRiver(a, b)) {
      blockedRiver++;
      continue;
    }
    edges.set(edgeKey(a.name, b.name), '생성');
    gen++;
  }
// 조각 잇기
const comps = () => {
  const adj = new Map(sites.map((s) => [s.name, []]));
  for (const k of edges.keys()) {
    const [a, b] = k.split('|');
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const seen = new Set(),
    out = [];
  for (const s of sites) {
    if (seen.has(s.name)) continue;
    const q = [s.name],
      cur = [s.name];
    seen.add(s.name);
    while (q.length)
      for (const n of adj.get(q.shift()))
        if (!seen.has(n)) {
          seen.add(n);
          q.push(n);
          cur.push(n);
        }
    out.push(cur);
  }
  return out;
};
let joined = 0;
for (let g = 0; g < 60; g++) {
  const cs = comps();
  if (cs.length <= 1) break;
  cs.sort((a, b) => a.length - b.length);
  const small = new Set(cs[0]);
  let best = null;
  for (const a of cs[0])
    for (const s of sites) {
      if (small.has(s.name)) continue;
      const d = dist(siteBy.get(a), s);
      if (!best || d < best[0]) best = [d, a, s.name];
    }
  edges.set(edgeKey(best[1], best[2]), '연결');
  joined++;
}
console.log(
  'gate blocked',
  blockedGate,
  'river blocked',
  blockedRiver,
  'long river lines',
  riverLines.length,
  'sea',
  seaAdded,
);
console.log('roads total', edges.size, 'kept', keptRoads, 'gen', gen, 'joined', joined, 'components', comps().length);
const nb = new Map(sites.map((s) => [s.name, []]));
const MODSITE = hsg.cities.map(([n]) => sites.find((x) => x.modName === n) ?? null);
console.log(
  'MODSITE',
  MODSITE.filter(Boolean).length,
  'of',
  MODSITE.length,
  'non-mod sites',
  sites.filter((x) => !x.modName).length,
);
for (const k of edges.keys()) {
  const [a, b] = k.split('|');
  nb.get(a).push(b);
  nb.get(b).push(a);
}

// ── 2. 명단 ─────────────────────────────────────────────
const noLife = new Map();
for (const tok of NO_LIFE.trim().split(/\s+/)) {
  const [k, life, ...chain] = tok.split(':');
  const [b, d] = life.split('-').map(Number);
  noLife.set(k, { b, d, chain: chain.join(':') });
}
const parseChain = (c) =>
  c
    ? c.split('>').map((seg, i) => {
        const m = seg.match(/^(?:(\d+):)?(\w+)$/);
        return { from: m?.[1] ? +m[1] : i === 0 ? -9999 : 0, key: m?.[2] };
      })
    : [];
const late = new Map();
for (const tok of LATE.trim().split(/\s+/)) {
  const [n, ...c] = tok.split(':');
  late.set(n, parseChain(c.join(':')));
}
const NAMEFIX = { 麹義: '국의', 麹演: '국연', 万彧: '만욱', 鄂煥: '악환' };
for (const r of roster) if (NAMEFIX[r.kanji]) r.name = NAMEFIX[r.kanji];
const DEATHFIX = { 公孫康: 221, 劉禅: 271, 孫亮: 260, 孫休: 264 };
const DEATH = {
  張嶷: 254,
  張翼: 264,
  馬忠: 249,
  張悌: 280,
  張済: 196,
  王基: 261,
  王頎: 270,
  周泰: 225,
  州泰: 261,
  楊秋: 220,
  楊醜: 199,
  張南: 222,
  張承: 244,
  韓忠: 184,
  李豊: 254,
  劉豹: 260,
  張顗: 200,
};
for (const r of roster) {
  const nl = noLife.get(r.kanji);
  r.birth = r.zBirth ?? r.coreBirth ?? nl?.b ?? null;
  r.death = DEATHFIX[r.kanji] ?? r.coreDeath ?? nl?.d ?? DEATH[r.kanji] ?? (r.birth != null ? r.birth + 60 : null);
  r.lifeSource = r.zBirth != null ? '삼국지10' : r.coreBirth != null ? 'core2026' : nl ? '추정' : '없음';
  r.debut = r.zDebut ?? (r.birth != null ? r.birth + 15 : null);
  r.chain = nl ? parseChain(nl.chain) : null;
  r.tier = 1;
}
const names = new Map();
const put = (r) => {
  if (!names.has(r.name)) names.set(r.name, []);
  names.get(r.name).push(r);
};
roster.forEach(put);
const SWAP = [
  ['노', '로'],
  ['누', '루'],
  ['나', '라'],
  ['낭', '랑'],
  ['양', '량'],
  ['여', '려'],
  ['유', '류'],
  ['이', '리'],
  ['요', '료'],
  ['연', '련'],
  ['영', '령'],
  ['낙', '락'],
  ['뇌', '뢰'],
  ['능', '릉'],
  ['다', '도'],
  ['즐', '질'],
  ['혹', '욱'],
  ['궤', '괴'],
];
const variants = (n) => {
  const out = [];
  [...n].forEach((ch, i) => {
    for (const [a, b] of SWAP) {
      if (ch === a || ch === b) {
        const to = ch === a ? b : a;
        out.push([...n].map((c, k) => (k === i ? to : c)).join(''));
      }
    }
  });
  return out;
};
const SPELL = {
  비의: '비위',
  관색: '관색',
  왕윤: '왕윤',
  장노: '장로',
  어부나: '어부라',
  향낭: '향랑',
  조누: '조루',
  요입: '요립',
  장억: '장의',
  포융: '포륭',
  주영: '주령',
  태사형: '태사향',
  동다나: '동도나',
  제갈양: '제갈량',
  왕낭: '왕랑',
  왕누: '왕루',
  축융부인: '축융',
  방통: '방통',
};
const tableRoster = [];
let tableMatched = 0;
const allTable = load(`${S}/data/hsg-all.json`);
for (const p of [...allTable, ...(ext.people ?? [])]) if (p.name === '아달라이') p.name = '아달라이사금';
const tableToR = new Map();
for (const p of allTable) {
  if (p.name === '독발수기') p.name = '독발수기능';
  const near = (r, tol) => r.birth == null || p.birth == null || Math.abs(r.birth - p.birth) <= tol;
  const cands = names.get(p.name) ?? [];
  let same = cands.find((r) => r.tier === 1 && near(r, 15)) ?? cands.find((r) => r.tier >= 2 && r.birth === p.birth);
  if (!same && SPELL[p.name]) same = (names.get(SPELL[p.name]) ?? []).find((r) => near(r, 25));
  if (!same)
    for (const v of variants(p.name)) {
      same = (names.get(v) ?? []).find(
        (r) => r.tier === 1 && r.birth != null && p.birth != null && Math.abs(r.birth - p.birth) <= 6,
      );
      if (same) break;
    }
  if (same) {
    tableMatched++;
    tableToR.set(p.id, same);
    if (!same.bio && p.bio) same.bio = p.bio;
    continue;
  }
  const r = {
    id: 20000 + p.id,
    name: p.name,
    kanji: '',
    birth: p.birth,
    death: p.birth != null ? p.birth + 60 : null,
    debut: p.birth != null ? p.birth + 15 : null,
    lifeSource: p.birth == null ? '열전(생년 미상)' : '열전',
    hasZ: false,
    tier: 2,
    chain: null,
    bio: p.bio,
  };
  tableRoster.push(r);
  put(r);
  tableToR.set(p.id, r);
}
// 사서에 칭호만 남은 군주
const TITLES = [
  ['진왕', 150, 280, 'mahan', '마한 목지국의 왕. 이름 미상. 辰王治月支國(三國志 卷30)'],
  ['불내예후', 150, 280, 'ye', '동예의 군장. 이름 미상. 不耐濊侯(三國志 卷30)'],
];
let titleN = 0;
for (const [name, birth, death, side, bio] of TITLES) {
  const r = {
    id: 29001 + titleN++,
    name,
    kanji: '',
    birth,
    death,
    debut: birth + 15,
    lifeSource: '사서 칭호',
    tier: 2,
    chain: [{ from: -9999, key: side }],
    bio,
  };
  tableRoster.push(r);
  put(r);
}
console.log('table people', ext.people.length, 'matched roster', tableMatched, 'new', tableRoster.length);
const lookup = (n0, birth) => {
  const n = names.has(n0) ? n0 : (SPELL[n0] ?? n0);
  const exact = names.get(n) ?? [];
  const pick = (cands, tol) => {
    const scored = cands
      .filter((r) => r.birth != null)
      .map((r) => [Math.abs(r.birth - birth), r])
      .sort((a, b) => a[0] - b[0]);
    if (scored.length && scored[0][0] <= tol) return scored[0][1];
    if (cands.length === 1 && cands[0].birth == null) return cands[0];
    return null;
  };
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const sc = exact
      .filter((r) => r.birth != null)
      .sort((a, c) => Math.abs(a.birth - birth) - Math.abs(c.birth - birth));
    if (sc.length) return sc[0];
  }
  for (const v of variants(n)) {
    const h = pick(names.get(v) ?? [], 12);
    if (h) return h;
  }
  return null;
};
const AI = (n) => {
  const p = `${S}/data/ai/${n}.json`;
  return fs.existsSync(p) ? load(p) : null;
};
const parseChain2 = (c) => (c ? parseChain(c) : null);
const rosterById0 = new Map([...roster, ...tableRoster].map((r) => [r.id, r]));
const stat = { aChain: 0, aDeath: 0, bVerified: 0, bBio: 0, cAdded: 0 };
for (const x of AI('A') ?? []) {
  const r = rosterById0.get(x.id);
  if (!r) continue;
  if (x.chain !== undefined) {
    r.chain = parseChain2(x.chain);
    stat.aChain++;
  }
  if (x.death && (!r.birth || x.death > r.birth)) {
    r.death = x.death;
    stat.aDeath++;
    r.deathBasis = '열전';
  }
  if (x.birth && r.birth === 185) {
    r.birth = x.birth;
    r.debut = x.birth + 15;
    if (r.lifeSource?.includes('미상')) r.lifeSource = '열전';
  }
  r.sideBasis = x.basis;
}
for (const x of AI('B') ?? []) {
  const r = rosterById0.get(x.id);
  if (!r) continue;
  if (x.verified) {
    if (x.birth) {
      r.birth = x.birth;
      r.debut = r.zDebut ?? x.birth + 15;
    }
    if (x.death) r.death = x.death;
    r.lifeSource = '사서 대조';
    stat.bVerified++;
  }
  if (x.chain) r.chain = parseChain2(x.chain);
  if (x.bio) {
    r.bio = x.bio;
    stat.bBio++;
  }
  if (x.source) r.src = x.source;
}
const BADBIO = new Set([10780, 10787, 10927, 10360, 10558, 10636, 10741, 10885, 10304]);
for (const id of BADBIO) {
  const r = rosterById0.get(id);
  if (r) r.bio = '동명이인 혼동으로 원문 설명을 지웠습니다. 사서 대조가 필요합니다.';
}
const gLinks = [];
for (const g of ['G1', 'G2', 'G3'])
  for (const x of AI(g) ?? []) {
    const r = tableToR.get(x.id);
    if (!r) continue;
    if (x.chain && (r.tier >= 2 || !r.coreBirth)) r.chain = parseChain2(x.chain);
    if (x.death && (r.birth == null || x.death > r.birth)) r.death = x.death;
    if (x.birth && r.birth == null) {
      r.birth = x.birth;
      r.debut = x.birth + 15;
      r.death = r.death ?? x.birth + 60;
      r.lifeSource = '열전(추정)';
    }
    if (x.master)
      gLinks.push({
        r,
        master: x.master,
        from: x.masterFrom ?? -9999,
        to: x.masterTo ?? 9999,
        relation: x.relation || 'STAFF',
        basis: x.basis === '추정' ? '추정' : '열전',
      });
  }
const cData = AI('C');
for (const x of cData?.people ?? []) {
  if ((names.get(x.name) ?? []).length) continue;
  const birth = x.birth ?? (x.death ? x.death - 55 : null);
  if (!birth) continue;
  const r = {
    id: 35000 + stat.cAdded,
    name: x.name,
    kanji: x.kanji ?? '',
    birth,
    death: x.death ?? birth + 60,
    debut: birth + 15,
    lifeSource: x.verified ? '사서 대조' : '추정',
    hasZ: false,
    tier: 3,
    chain: parseChain2(x.chain),
    bio: x.bio ?? '',
    src: x.source ?? '',
  };
  tableRoster.push(r);
  put(r);
  stat.cAdded++;
}
for (const [n, dy] of [
  ['손준', 256],
  ['손침', 258],
])
  for (const r of names.get(n) ?? []) if (r.birth != null && r.birth > 200) r.death = dy;
console.log('AI merge', JSON.stringify(stat), 'rejected', cData?.rejected?.length ?? 0);
let nextId = 30001;
const extra = [];
const rowMap = new Map();
for (const s of hsg.scen)
  for (const row of s.rows) {
    const key = `${row[0]}|${row[4]}`;
    if (rowMap.has(key)) continue;
    let r = lookup(row[0], row[4]);
    if (!r) {
      r = {
        id: nextId++,
        name: row[0],
        kanji: '',
        birth: row[4],
        death: null,
        debut: row[3],
        lifeSource: '모드',
        hasZ: false,
        tier: 2,
        chain: null,
      };
      extra.push(r);
      put(r);
    }
    r.inMod = true;
    r.stats = row[7];
    rowMap.set(key, r);
  }
// 확장 인물(번호 700 이상)은 모드 인물 번호로 명단에 잇는다. 번호는 DLL 인물 표 번호와 같다.
const PIDREC = new Map();
const PIDSTAT = { split: 0 };
{
  const okStats = (v) => v && v.length === 5 && v.every((x) => x > 0 && x <= 120);
  const isAct = (r) => r[2] === 0 || r[2] === 1 || r[2] === 2;
  const prelim = new Map();
  const births = new Map();
  const active = new Set();
  for (const s of hsg.scen)
    for (const r of s.xrows) {
      if (isAct(r)) active.add(r[8]);
      if (r[4] && r[4] !== 185) {
        if (!births.has(r[8])) births.set(r[8], new Map());
        const b = births.get(r[8]);
        b.set(r[4], (b.get(r[4]) ?? 0) + 1);
      }
      if (!prelim.has(r[8])) prelim.set(r[8], tableToR.get(r[8]) ?? lookup(r[0], r[4]) ?? null);
    }
  // 한 판 안에서 같은 명단 인물에 활동 인물 둘이 걸리면 번호가 큰 쪽을 다른 사람으로 본다.
  const needSplit = new Set();
  for (const s of hsg.scen) {
    const m = MODX[s.file];
    const owner = new Map();
    for (const r of m.n24) {
      if (!isAct(r)) continue;
      const rec = rowMap.get(`${r[0]}|${r[4]}`);
      if (rec && !owner.has(rec.id)) owner.set(rec.id, r[8]);
    }
    for (const r of s.xrows) {
      if (!isAct(r)) continue;
      const rec = prelim.get(r[8]);
      if (!rec) continue;
      if (owner.has(rec.id) && owner.get(rec.id) !== r[8]) needSplit.add(r[8]);
      else owner.set(rec.id, r[8]);
    }
  }
  let split = 0,
    viaTable = 0,
    viaName = 0,
    fresh = 0;
  for (const s of hsg.scen)
    for (const r of s.xrows) {
      const pid = r[8];
      if (PIDREC.has(pid)) continue;
      let rec = prelim.get(pid);
      if (rec) {
        if (tableToR.get(pid) === rec) viaTable++;
        else viaName++;
      }
      if (rec && needSplit.has(pid)) {
        rec = null;
        split++;
      }
      if (!rec) {
        const b = births.get(pid);
        const birth = b ? [...b.entries()].sort((p, q) => q[1] - p[1])[0][0] : r[4];
        rec = {
          id: nextId++,
          name: r[0],
          kanji: '',
          birth,
          death: null,
          debut: r[3],
          lifeSource: '모드',
          hasZ: false,
          tier: 2,
          chain: null,
        };
        extra.push(rec);
        put(rec);
        fresh++;
      }
      rec.inMod = true;
      if (okStats(r[7]) && (active.has(pid) || !okStats(rec.stats))) rec.stats = r[7];
      PIDREC.set(pid, rec);
    }
  PIDSTAT.split = needSplit.size;
  console.log('SPLIT', [...needSplit].map((p) => `${p}:${PIDREC.get(p).name}`).join(' '));
  console.log('PIDREC', PIDREC.size, 'viaTable', viaTable, 'viaName', viaName, 'split', split, 'fresh', fresh);
}
// 세력색
const NAMU_KEY = {
  cao: '#2424E9',
  shu: '#367805',
  wu: '#CA0533',
  gsz: '#F76E19',
  xu: '#CDE4AC',
  dong: '#595959',
  lu: '#333333',
  zx: '#AE546F',
  ma: '#785011',
  hansui: '#7B6300',
  man: '#B25759',
  yuan: '#E5BD11',
  yuantan: '#D9799F',
  ys: '#D7789B',
  yi: '#190571',
  jing: '#72B9C1',
  hj: '#E78C11',
  han: '#D1B159',
  liaodong: '#CCB7D8',
  kr: '#C5417A',
  gz: '#24938D',
  jiao: '#A73649',
  ybh: '#7A6633',
  wl: '#9D9D9D',
  ld: '#7186D1',
  liuyao: '#055B9E',
  ly: '#5B1143',
  zl: '#80DA75',
  zy: '#592805',
  hs: '#403A7D',
  dingy: '#910560',
  hf: '#811E2C',
};
const NAMU_NAME = { 장제: '#AE546F', 원담: '#D9799F', 이각: '#595959' };
const MODRULER = new Map();
for (const c of load(`${S}/data/mod-colors.json`).names) {
  const rec = c.pid >= 700 ? PIDREC.get(c.pid) : rowMap.get(`${c.name}|${c.birth}`);
  if (rec) MODRULER.set(`${c.file}|${c.slot}`, rec.name);
}
const MODCOLORS = load(`${S}/data/mod-colors.json`);
const MODALLY = load(`${S}/data/mod-ally.json`);
const MODREL = load(`${S}/data/mod-rel.json`);
const DIPERR = [];
const DIPCLAIM = new Map();
const DIPMISS = new Set();
const MODCOL = new Map();
{
  const votes = new Map();
  for (const c of MODCOLORS.names) {
    if (c.file === 15 || c.file === 30) continue;
    const rec = c.pid >= 700 ? PIDREC.get(c.pid) : rowMap.get(`${c.name}|${c.birth}`);
    if (!rec) continue;
    if (!votes.has(rec.name)) votes.set(rec.name, new Map());
    const v = votes.get(rec.name);
    v.set(c.hex, (v.get(c.hex) ?? 0) + 1);
  }
  for (const [n, v] of votes) MODCOL.set(n, [...v.entries()].sort((a, c) => c[1] - a[1])[0][0]);
}
// 나무위키에 있으면 그 색, 없으면 후삼국지 색(그 판 그 칸의 값 → 같은 군주가 다른 판에서 쓴 값), 그래도 없으면 자동
const factionColor = (name, key, y, fid, file, sameRuler) => {
  if (NAMU_NAME[name]) return [NAMU_NAME[name], '나무위키'];
  if (key === 'qm') return [y < 189 ? '#F8C0C0' : '#A084E0', '나무위키'];
  if (NAMU_KEY[key]) return [NAMU_KEY[key], '나무위키'];
  const slot = sameRuler ? MODCOLORS.slots[file]?.[fid] : null;
  if (slot) return [slot, '후삼국지'];
  if (MODCOL.has(name)) return [MODCOL.get(name), '후삼국지'];
  return null;
};
const nameCount = {};
for (const [n, v] of names) nameCount[n] = v.length;
for (const r of [...roster, ...tableRoster, ...extra])
  r.label = nameCount[r.name] > 1 ? `${r.name}${r.kanji ? `(${r.kanji})` : `(${r.birth}년생)`}` : r.name;
const allRoster = [...roster, ...tableRoster, ...extra];
const byId = new Map(allRoster.map((r) => [r.id, r]));
const candidates = hsg.dict.filter((n) => !names.has(n) && !variants(n).some((v) => names.has(v)));
console.log(
  'roster base',
  roster.length,
  'table new',
  tableRoster.length,
  'mod matched',
  roster.filter((r) => r.inMod).length,
  'extra with data',
  extra.length,
  'name-only candidates',
  candidates.length,
);
console.log(
  'extra sample',
  extra
    .slice(0, 60)
    .map((r) => `${r.name}:${r.birth}`)
    .join(' '),
);

// ── 3. 표본(이전 원장) ──────────────────────────────────
const lifeOK = (r, y) => r.birth != null && (r.debut ?? r.birth + 15) <= y && (r.death ?? 9999) >= y;
const pickAt = (name, y) => {
  const c = names.get(name) ?? names.get(name.replace(/\d+$/, ''));
  if (!c) return null;
  return c.find((r) => lifeOK(r, y)) ?? c[0];
};
const samples = [
  '1010',
  '1020',
  '1021',
  '1030',
  '1031',
  '1040',
  '1041',
  '1050',
  '1060',
  '1070',
  '1080',
  '1090',
  '1100',
  '1110',
]
  .map((id) => {
    const c = load(`${R}/resources/scenario/scenario_${id}.json`);
    const nat = c.nation.map((n) => LINEAGE[n[0]] ?? null);
    const row = new Map();
    for (const g of [...c.general, ...(c.general_ex ?? [])]) {
      const r = pickAt(g[1], c.startYear + 3);
      if (r) row.set(r.id, g[3] > 0 ? nat[g[3] - 1] : null);
    }
    return { year: c.startYear + 3, row };
  })
  .sort((a, b) => a.year - b.year);
const LIN2 = {
  ...LINEAGE,
  고국천왕: 'gog',
  조방: 'cao',
  조모: 'cao',
  조환: 'cao',
  사마소: 'cao',
  사마염: 'cao',
  제갈양: 'shu',
  제갈량: 'shu',
  강유: 'shu',
  장비: 'shu',
  손량: 'wu',
  손호: 'wu',
  손휴: 'wu',
  장노: 'zl',
  왕낭: 'wl',
  어부나: 'hun',
  어부라: 'hun',
  호주천: 'hun',
  구역거: 'wuhuan',
  답둔: 'wuhuan',
  번임: 'shanyue',
  비잔: 'shanyue',
  강단: 'qiang',
  철리길: 'qiang',
  미당대왕: 'qiang',
  가비능: 'xianbei',
  부건: 'di',
  아귀: 'di',
  동다나: 'man',
  옹개: 'man',
  고정: 'man',
  황난: 'man',
  공손연: 'liaodong',
  정원: 'dingy',
  교모: 'qm',
  장막: 'zm',
  허공: 'xg',
  양봉: 'yf',
  곽사: 'dong',
  장제: 'dong',
  왕윤: 'han',
  관해: 'hj',
  하의: 'hj',
  장각: 'hj',
  하진: 'han',
  태사자: 'liuyao',
  장패: 'zb',
  원상: 'yuan',
  양추: 'ma',
  골진: 'wuhuan',
};
const chainAt = (ch, y) => {
  let k = null;
  for (const c of ch) if (c.from <= y) k = c.key;
  return k;
};
const sideOf = (r, y) => {
  const lt = late.get(r.name);
  if (lt && (y > 228 || !samples.some((s) => s.row.get(r.id)))) return [chainAt(lt, y), '후기표'];
  if (r.chain?.length) return [chainAt(r.chain, y), '추정'];
  let last,
    has = false;
  for (const s of samples)
    if (s.year <= y && s.row.has(r.id)) {
      last = s.row.get(r.id);
      has = true;
    }
  return has ? [last, '표본'] : [null, null];
};
const resolve = (key, y, keys) => {
  let k = key,
    g = 0;
  while (k && !keys.has(k) && g++ < 8) {
    const a = ABSORB[k];
    if (!a || a[0] > y) return null;
    k = a[1];
  }
  return k && keys.has(k) ? k : null;
};
const hue = (i) => `hsl(${(i * 47) % 360} 55% 48%)`;
const COLOR = {
  gog: '#a0522d',
  bj: '#8a3f9e',
  sr: '#c8a400',
  gy: '#3c8dad',
  by: '#557a46',
  wa: '#c2185b',
  guno: '#7d1a4a',
  mahan: '#6d6875',
  ye: '#7f8c8d',
  cao: '#2f6fb3',
  shu: '#2f9e5b',
  wu: '#d1483f',
  yuan: '#d9a514',
  dong: '#6b4fa3',
  lu: '#c2410c',
  ys: '#9d6b3d',
  gsz: '#74808c',
  jing: '#1596a0',
  yi: '#7c9a2e',
  zl: '#b5457e',
  ma: '#8a5a2b',
  hansui: '#a0764a',
  liaodong: '#5d6dbe',
  jiao: '#3aa78f',
  hj: '#e0b100',
  han: '#8b3a3a',
  man: '#cc7a29',
  xianbei: '#7b8ca3',
  zd: '#b65a2e',
  sima: '#3d4f8a',
  xiahou: '#1b8f8f',
};

// ── 4. 시나리오 ─────────────────────────────────────────
const IFID = new Set([15, 27, 28, 29, 30]);
const PREMISE = {
  1: '태평도가 일어나고 조정과 지방 군벌이 맞선다.',
  2: '동탁이 수도를 쥐고 관동의 제후가 칼을 든다.',
  3: '여포가 연주를 치고 군웅이 중원을 나눠 갖는다.',
  4: '원소의 대군이 남하하고 조조가 관도를 지킨다.',
  5: '조조가 북방을 마무리하고 유비가 융중을 찾는다.',
  6: '유비가 한중을 얻고 관우가 형주에서 북진을 준비한다.',
  7: '제갈량의 마지막 북벌. 위수 남쪽에서 사마의와 맞선다.',
  8: '유비가 의용군으로 시작하는 판.',
  9: '헌제를 맞아 허로 옮기는 조조의 판.',
  10: '원소와 공손찬이 하북을 두고 다툰다.',
  11: '원술이 황제를 칭하고 천하의 적이 된다.',
  12: '유종의 항복과 조조의 남하, 장강의 결전.',
  13: '마초와 관서 군벌이 동관에서 조조를 막는다.',
  14: '제갈량이 처음 기산으로 나선다.',
  15: '세대가 다른 황제들이 한자리에 선다. 원작 표기는 영웅 집결이다.',
  16: '동탁이 죽은 뒤 장안이 흔들리고 군웅이 움직인다.',
  17: '적벽 뒤 형주를 둘러싼 세 세력의 재편.',
  18: '유비가 죽고 제갈량이 어린 황제를 맡는다.',
  19: '공손찬이 기주를 노리는 판.',
  20: '손책이 허도를 치려는 순간을 잡은 판.',
  21: '원소가 죽고 아들들이 갈라선다.',
  22: '강유가 북벌을 이어가는 후기 판.',
  23: '제갈탄이 수춘에서 사마소에 맞선다.',
  24: '공손찬이 역경에 갇히고 여포가 하비에서 몰린다.',
  25: '유비가 형주를 되찾으러 장강을 내려간다.',
  26: '사마의가 요동의 공손연을 친다.',
  27: '관도에서 원소가 이긴 뒤의 세상.',
  28: '손책이 살아남아 북상하는 세상.',
  29: '관우가 번성에서 이기고 형주를 지킨 세상.',
  30: '시대를 넘어 군주들이 모인다.',
};
const EST_PATH = `${S}/data/stats-est.json`;
const EST = fs.existsSync(EST_PATH) ? load(EST_PATH) : {};
for (const r of byId.values()) {
  const ok = r.stats && r.stats.length === 5 && r.stats.every((v) => v > 0 && v <= 120);
  if (ok) r.statSrc = '모드';
  else {
    r.stats = EST[r.id] ?? null;
    r.statSrc = r.stats ? '추정' : '';
  }
}
const oldRoster = new Map(
  fs
    .readFileSync(`${S}/data/batch/E-roster.tsv`, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .map((c) => [+c[0], c[1]]),
);
const remap = (id) => {
  if (byId.has(id)) return id;
  const lab = oldRoster.get(id);
  if (!lab) return null;
  const n = lab.replace(/\(.*\)$/, '');
  return names.get(n)?.[0]?.id ?? null;
};
const LINKS = [
  ...[...(AI('E1') ?? []), ...(AI('E2') ?? [])].map((l) => ({
    ...l,
    person: remap(l.person),
    master: remap(l.master),
  })),
  ...gLinks.map((l) => ({
    person: l.r.id,
    master: null,
    masterName: l.master,
    from: l.from,
    to: l.to,
    relation: l.relation,
    basis: l.basis,
  })),
].filter((l) => l.person != null);
const RANK = { 사서: 0, 열전: 1, 추정: 2 };
LINKS.sort((a, c) => (RANK[a.basis] ?? 3) - (RANK[c.basis] ?? 3));
console.log('links', LINKS.length);
const result = [];
const specErrors = [];
const MERGED = [];
const SPECFIX = {
  s0185: { drop: { 한수: ['포한'], 하진: ['진'] } },
  s0188: { drop: { 하진: ['진'] }, absorb: { 포신: '하진', 원유: '하진', 초화: '하진' } },
  x0189a: { drop: { 하진: ['진'] }, absorb: { 포신: '하진', 원유: '하진', 초화: '하진' } },
  x0195a: { drop: { 조조: ['진'] } },
  s0199: { drop: { 원소: ['어양'] } },
  x0200a: { drop: { 조인: ['동해'] } },
  x0209a: { absorb: { 오거: '유비' } },
};
const applySpec = (sp, { owner, placed, facInfo, facRow, y, fills }) => {
  const err = (m) => specErrors.push(`${sp.id}: ${m}`);
  const siteN = (n) => (siteBy.has(n) ? n : [...siteBy.values()].find((x) => x.modName === n || x.sanName === n)?.name);
  const facOf = (name) =>
    [...facInfo.values()].find((f) => f.name === name || f.rulerLabel === name || facRow.get(f.fid)?.name === name);
  let nf = 300;
  for (const [oldN, newN] of Object.entries(sp.rulers ?? {})) {
    const f = facOf(oldN);
    const r = pickAt(newN, y);
    if (!f) {
      err('rulers: 세력 없음 ' + oldN);
      continue;
    }
    if (!r) {
      err('rulers: 인물 없음 ' + newN);
      continue;
    }
    const city = placed.get(f.ruler)?.city ?? '';
    f.ruler = r.id;
    f.rulerLabel = r.label;
    f.name = sp.factionName?.[oldN] ?? r.name;
    facRow.set(f.fid, r);
    placed.set(r.id, { fac: f.fid, city, src: '지정', rank: 0 });
    const old = pickAt(oldN, y);
    if (old && !lifeOK(old, y)) placed.delete(old.id);
  }
  for (const d of sp.newFactions ?? []) {
    const r = pickAt(d.ruler, y);
    if (!r) {
      err('newFactions: 인물 없음 ' + d.ruler);
      continue;
    }
    const same = [...facInfo.values()].find((f) => f.ruler === r.id);
    if (same) {
      same.name = d.name ?? same.name;
      const cs = siteN(d.capital);
      if (cs) {
        owner.set(cs, same.fid);
        const rp = placed.get(r.id);
        if (rp) rp.city = cs;
      }
      MERGED.push(`${sp.id}:${same.name}`);
      continue;
    }
    const fid = nf++;
    facRow.set(fid, r);
    facInfo.set(fid, {
      fid,
      key: d.key ?? `x${fid}`,
      name: d.name ?? r.name,
      ruler: r.id,
      rulerLabel: r.label,
      color: d.color ?? COLOR[d.key] ?? hue(fid),
    });
    placed.set(r.id, { fac: fid, city: siteN(d.capital) ?? '', src: '지정', rank: 0 });
    if (d.capital && siteN(d.capital)) owner.set(siteN(d.capital), fid);
  }
  for (const [fn, list] of Object.entries(sp.cities ?? {})) {
    const f = facOf(fn);
    if (!f) {
      err('cities: 세력 없음 ' + fn);
      continue;
    }
    for (const c of list) {
      const n = siteN(c);
      if (!n) {
        err('cities: 거점 없음 ' + c);
        continue;
      }
      owner.set(n, f.fid);
      fills.delete(n);
    }
  }
  for (const c of sp.blank ?? []) {
    const n = siteN(c);
    if (n) owner.delete(n);
    else err('blank: 거점 없음 ' + c);
  }
  for (const [from, to] of Object.entries(sp.absorb ?? {})) {
    const fa = facOf(from),
      ta = to === '재야' ? null : facOf(to);
    if (!fa) {
      err('absorb: 세력 없음 ' + from);
      continue;
    }
    if (to !== '재야' && !ta) {
      err('absorb: 세력 없음 ' + to);
      continue;
    }
    for (const p of placed.values())
      if (p.fac === fa.fid) {
        p.fac = ta ? ta.fid : -1;
        if (p.rank === 0) p.rank = 2;
      }
    for (const [c, o] of [...owner])
      if (o === fa.fid) {
        if (ta) owner.set(c, ta.fid);
        else owner.delete(c);
      }
    facInfo.delete(fa.fid);
    facRow.delete(fa.fid);
  }
  for (const [fn, cts] of Object.entries(sp.heroes ?? {})) {
    const f = fn === '재야' ? null : facOf(fn);
    if (fn !== '재야' && !f) {
      err('heroes: 세력 없음 ' + fn);
      continue;
    }
    for (const [c, list] of Object.entries(cts)) {
      const n = siteN(c);
      if (!n) {
        err('heroes: 거점 없음 ' + c);
        continue;
      }
      for (const nm of list) {
        const r = pickAt(nm, y);
        if (!r) {
          err('heroes: 인물 없음 ' + nm);
          continue;
        }
        if (!lifeOK(r, y) && !sp.allowDead) err(`heroes: 시기 어긋남 ${nm} ${r.birth}~${r.death}`);
        placed.set(r.id, { fac: f ? f.fid : -1, city: n, src: '지정', rank: f && r.id === f.ruler ? 0 : 1 });
      }
    }
  }
  // 빼앗긴 도시의 인물은 자기 세력 군주 곁으로
  for (const p of placed.values()) {
    if (p.fac >= 0 && p.city && owner.get(p.city) !== p.fac && p.src !== '지정') {
      const f = facInfo.get(p.fac);
      const rc = f && placed.get(f.ruler)?.city;
      if (rc) {
        p.city = rc;
        p.auto = 1;
      }
    }
  }
  // 군주 도시가 비었으면 자기 땅으로
  for (const f of facInfo.values()) {
    const rp = placed.get(f.ruler);
    if (rp && (!rp.city || owner.get(rp.city) !== f.fid)) {
      const c = [...owner].find(([, o]) => o === f.fid)?.[0];
      if (c) rp.city = c;
    }
  }
};
const SUCC = {
  조조: [220, '조비'],
  조비: [226, '조예'],
  조예: [239, '조방'],
  조방: [254, '조모'],
  조모: [260, '조환'],
  조환: [265, '사마염'],
  사마소: [265, '사마염'],
  사마의: [251, '사마사'],
  사마사: [255, '사마소'],
  유비: [223, '유선'],
  유언: [194, '유장'],
  손견: [191, '손책'],
  손책: [200, '손권'],
  손권: [252, '손량'],
  손량: [258, '손휴'],
  손휴: [264, '손호'],
  원소: [202, '원상'],
  공손도: [204, '공손강'],
  공손강: [221, '공손공'],
  공손공: [228, '공손연'],
  마등: [212, '마초'],
  유표: [208, '유종'],
  동탁: [192, '이각'],
};
const build = (s, opt = {}) => {
  const y = opt.year ?? s.year;
  const shift = y !== s.year;
  const reviveSet = new Set(opt.revive ?? []);
  const exclSet = new Set(opt.exclude ?? []);
  const facRow = new Map();
  const deadRuler = new Map();
  const placed = new Map();
  for (const row of [...s.rows, ...s.xrows]) {
    const [n, st, st2, , birth, fac, city] = row;
    const r = row[8] != null ? PIDREC.get(row[8]) : rowMap.get(`${n}|${birth}`);
    if (!r) continue;
    {
      const prev = placed.get(r.id);
      if (prev && prev.fac >= 0 && !(st2 === 0 && fac < 64 && st === 0)) continue;
    }
    if (st2 === 5 || st2 === 3) {
      if (!reviveSet.has(r.name)) continue;
    }
    if (exclSet.has(r.name)) continue;
    if (shift && !reviveSet.has(r.name) && !lifeOK(r, y)) {
      if (st === 0 && st2 === 0 && fac < 64 && !deadRuler.has(fac)) deadRuler.set(fac, { r, city });
      continue;
    }
    if (st2 !== 0 && !(st2 === 1 || st2 === 2)) continue;
    const cityName = city < 250 ? hsg.cities[city][0] : null;
    const site = cityName ? [...sites].find((x) => x.modName === cityName) : null;
    if ((st2 === 0 || reviveSet.has(r.name)) && fac < 64) {
      if (st === 0) facRow.set(fac, r);
      placed.set(r.id, { fac, city: site?.name ?? '', src: '모드', rank: st });
    } else if (st2 === 1 || st2 === 2) {
      placed.set(r.id, { fac: -1, city: site?.name ?? '', src: '모드', rank: 3 });
    }
  }
  // 시간 이동: 죽은 군주는 승계
  for (const [f, d0] of deadRuler) {
    if (facRow.has(f)) continue;
    let name = d0.r.name,
      g = 0,
      c = null;
    while (SUCC[name] && g++ < 8) {
      name = SUCC[name][1];
      const t = pickAt(name, y);
      if (t && lifeOK(t, y)) {
        c = t;
        break;
      }
    }
    if (!c) continue;
    const cityName = d0.city < 250 ? hsg.cities[d0.city][0] : null;
    const site = cityName ? sites.find((x) => x.modName === cityName) : null;
    facRow.set(f, c);
    placed.set(c.id, { fac: f, city: site?.name ?? '', src: '승계', rank: 0 });
  }
  for (const [f, ru] of [...facRow]) {
    if (lifeOK(ru, y) || reviveSet.has(ru.name) || !shift) continue;
    let name = ru.name,
      g = 0;
    while (SUCC[name] && g++ < 8) {
      const nx = SUCC[name][1];
      name = nx;
      const c = pickAt(nx, y);
      if (c && lifeOK(c, y)) break;
    }
    const c = pickAt(name, y);
    if (c && lifeOK(c, y)) {
      facRow.set(f, c);
      placed.set(c.id, { fac: f, city: placed.get(ru.id)?.city ?? '', src: '승계', rank: 0 });
    }
  }
  // 한반도·왜·부여는 시대에 맞는 군주로 바꾼다(시간을 옮긴 판만). 땅은 모드 표를 그대로 쓴다.
  if (shift)
    for (const [key, tbl] of Object.entries(REIGN)) {
      let f = [...facRow].find(([, ru]) => KLIN[ru.name] === key)?.[0];
      let city = f !== undefined ? placed.get(facRow.get(f).id)?.city : undefined;
      if (f === undefined) {
        const d = [...deadRuler].find(([, d0]) => KLIN[d0.r.name] === key);
        if (d) {
          f = d[0];
          const st = d[1].city < 250 ? MODSITE[d[1].city] : null;
          city = st?.name ?? '';
        }
      }
      if (f === undefined) continue;
      const nm = tbl.find(([to]) => y < to)?.[1] ?? null;
      const cur = facRow.get(f);
      if (cur && cur.name === nm) continue;
      if (cur) {
        const p = placed.get(cur.id);
        if (p) {
          if (lifeOK(cur, y)) p.rank = 2;
          else placed.delete(cur.id);
        }
        facRow.delete(f);
      }
      const c = nm ? pickAt(nm, y) : null;
      if (c) {
        facRow.set(f, c);
        placed.set(c.id, { fac: f, city: city ?? '', src: '승계', rank: 0 });
      }
    }
  const facIds = [...new Set([...placed.values()].map((p) => p.fac).filter((f) => f >= 0))]
    .filter((f) => facRow.has(f))
    .sort((a, b) => a - b);
  // 군주 없는 세력의 인물은 재야로
  for (const p of placed.values())
    if (p.fac >= 0 && !facRow.has(p.fac)) {
      p.fac = -1;
      p.src = '모드';
    }
  const facInfo = new Map(
    facIds.map((f) => {
      const ru = facRow.get(f);
      const key = LIN2[ru.name] ?? KLIN[ru.name] ?? `f${f}:${ru.name}`;
      return [
        f,
        {
          fid: f,
          key,
          name: PNAME[key] ?? ru.name,
          ruler: ru.id,
          rulerLabel: ru.label,
          color: COLOR[key] ?? hue(f + 3),
        },
      ];
    }),
  );
  // 소유: 모드 시나리오의 도시 표(N24 51곳 + 확장 199곳)를 그대로 쓴다. 공백지는 공백지로 둔다.
  const owner = new Map();
  const fills = new Set();
  s.own.forEach((f, i) => {
    if (f < 0 || !facInfo.has(f)) return;
    const st = MODSITE[i];
    if (st) owner.set(st.name, f);
  });
  // 시나리오별 덮어쓰기(IF)
  opt.patch?.({ owner, placed, facInfo, facRow, facIds, y, pickAt, sites, COLOR, fills });
  if (opt.spec) applySpec(opt.spec, { owner, placed, facInfo, facRow, y, fills });
  // 모드에 없는 거점(SAN10 유지·전장)은 길로 가장 가까운 모드 도시를 따른다. 그 도시가 공백지면 같이 공백지다.
  {
    const blankSet = new Set(
      (opt.spec?.blank ?? []).map((n) =>
        siteBy.has(n) ? n : [...siteBy.values()].find((x) => x.modName === n || x.sanName === n)?.name,
      ),
    );
    const pending = [];
    for (const st of sites) {
      if (st.modName || owner.has(st.name) || blankSet.has(st.name)) continue;
      const seen = new Set([st.name]);
      let layer = [st.name],
        hit = [];
      while (layer.length && !hit.length) {
        const next = [];
        for (const c of layer)
          for (const n of nb.get(c) ?? []) {
            if (seen.has(n)) continue;
            seen.add(n);
            const t = siteBy.get(n);
            if (!t) continue;
            if (t.modName) hit.push(t);
            else next.push(n);
          }
        layer = next;
      }
      if (!hit.length) continue;
      hit.sort((p, q) => Math.hypot(p.x - st.x, p.y - st.y) - Math.hypot(q.x - st.x, q.y - st.y));
      const f = owner.get(hit[0].name);
      if (f !== undefined) pending.push([st.name, f]);
    }
    for (const [n, f] of pending) {
      owner.set(n, f);
      fills.add(n);
    }
  }
  // 땅이 하나도 없는 세력은 세우지 않는다. 사람은 재야로 둔다.
  const dissolved = [];
  {
    const held = new Set(owner.values());
    for (const [fid, fi] of [...facInfo]) {
      if (held.has(fid)) continue;
      dissolved.push(fi.name);
      facInfo.delete(fid);
      facRow.delete(fid);
      for (const p of placed.values())
        if (p.fac === fid) {
          p.fac = -1;
          p.rank = 3;
        }
    }
  }
  // 세력색: 나무위키 상징색 → 후삼국지 색 번호 표 → 후삼국지 화면 근사 → 자동
  for (const fi of facInfo.values()) {
    const nm = byId.get(fi.ruler)?.name;
    const k = LIN2[nm] ?? KLIN[nm] ?? fi.key;
    const mr = MODRULER.get(`${s.file}|${fi.fid}`);
    const c = factionColor(nm, k, y, fi.fid, s.file, mr === nm || (KLIN[mr] === k && k !== undefined));
    if (c) {
      fi.color = c[0];
      fi.colorSrc = c[1];
    } else fi.colorSrc = '자동';
  }
  // 수도
  const list = [...facInfo.values()];
  for (const fi of list) {
    const rp = placed.get(fi.ruler);
    fi.capital =
      rp?.city && owner.get(rp.city) === fi.fid
        ? rp.city
        : ([...owner].find(([, f]) => f === fi.fid)?.[0] ?? rp?.city ?? '');
    fi.cities = [...owner].filter(([, f]) => f === fi.fid).map(([c]) => c);
  }
  // 모드에 없는 명단 인물
  let fb = 0;
  const keys = new Set(list.map((f) => f.key));
  const byKey = new Map(list.map((f) => [f.key, f.fid]));
  if (!opt.allEra)
    for (const r of allRoster) {
      if (placed.has(r.id) || (r.inMod && !shift) || !lifeOK(r, y) || exclSet.has(r.name)) continue;
      const [k, src] = sideOf(r, y);
      const rk = resolve(k, y, keys);
      if (rk) {
        const dc = r.debutCity
          ? [...sites].find((x) => x.name === r.debutCity || x.modName === r.debutCity || x.sanName === r.debutCity)
              ?.name
          : null;
        let fid = byKey.get(rk);
        if (opt.id?.startsWith('g249') && rk === 'cao' && dc) {
          const o = owner.get(dc);
          const fo = o !== undefined ? facInfo.get(o) : null;
          if (fo && ['cao', 'sima', 'xiahou'].includes(fo.key)) fid = o;
        }
        const fi = facInfo.get(fid);
        const own = dc && owner.get(dc) === fid;
        placed.set(r.id, { fac: fid, city: own ? dc : fi.capital, src: src ?? '표본', auto: 1, rank: 2 });
        fb++;
      } else {
        const dc = r.debutCity
          ? [...sites].find((x) => x.name === r.debutCity || x.modName === r.debutCity || x.sanName === r.debutCity)
              ?.name
          : '';
        placed.set(r.id, { fac: -1, city: dc ?? '', src: '재야', rank: 3 });
        fb++;
      }
    }
  const moved = [];
  for (const fi of list) fi.cities = [...owner].filter(([, f]) => f === fi.fid).map(([n]) => n);
  // 검사
  const issues = [];
  for (const n of dissolved) issues.push({ k: '땅이 없어 뺀 세력', v: n });
  for (const fi of list) {
    if (!fi.cities.length) issues.push({ k: '도시 없는 세력', v: fi.name });
    if (!fi.cities.length) continue;
    const seen = new Set([fi.capital]);
    const q = [fi.capital];
    while (q.length)
      for (const n of nb.get(q.shift()) ?? [])
        if (!seen.has(n) && owner.get(n) === fi.fid) {
          seen.add(n);
          q.push(n);
        }
    const out = fi.cities.filter((c) => !seen.has(c));
    if (out.length)
      issues.push({
        k: '월경지',
        v: `${fi.name}: ${out.slice(0, 8).join('·')}${out.length > 8 ? ` 외 ${out.length - 8}` : ''}`,
      });
    const cap = siteBy.get(fi.capital);
    if (cap && cap.kind === 'P') issues.push({ k: '수도가 관문', v: `${fi.name}: ${fi.capital}` });
  }
  const idx = new Map(list.map((f, i) => [f.fid, i]));
  // 휘하 트리: 기록된 관계 → 같은 도시의 태수 → 군주 순. 직속 명망 30 안에서 아래로 내린다.
  const costOf = (r) => {
    const s = r.stats;
    if (!s) return 6;
    return Math.max(1, Math.ceil(s.reduce((n, v) => n + (v < 200 ? v : 0), 0) / 50));
  };
  const parent = new Map(),
    relOf = new Map(),
    basisOf = new Map(),
    direct = new Map();
  const rulers = new Set(list.map((f) => f.ruler));
  const kidsOf = new Map();
  const addLink = (id, m, rel, basis) => {
    parent.set(id, m);
    relOf.set(id, rel);
    basisOf.set(id, basis);
    direct.set(m, (direct.get(m) ?? 0) + costOf(byId.get(id)));
    if (!kidsOf.has(m)) kidsOf.set(m, []);
    kidsOf.get(m).push(id);
  };
  const cyc = (id, m) => {
    let c = m,
      g = 0;
    while (c !== undefined && g++ < 200) {
      if (c === id) return true;
      c = parent.get(c);
    }
    return false;
  };
  for (const l of LINKS) {
    if (l.from > y || l.to < y) continue;
    const masterId = l.master ?? pickAt(l.masterName, y)?.id;
    if (masterId == null || masterId === l.person) continue;
    const pp = placed.get(l.person),
      pm = placed.get(masterId);
    if (
      !pp ||
      !pm ||
      pp.fac < 0 ||
      pp.fac !== pm.fac ||
      rulers.has(l.person) ||
      parent.has(l.person) ||
      cyc(l.person, masterId)
    )
      continue;
    const r = byId.get(l.person);
    if ((direct.get(masterId) ?? 0) + costOf(r) > 30) continue;
    addLink(l.person, masterId, l.relation, l.basis);
  }
  const fitUnder = (start, id) => {
    const cost = costOf(byId.get(id));
    const q = [start];
    const seen = new Set();
    while (q.length) {
      const m = q.shift();
      if (seen.has(m)) continue;
      seen.add(m);
      if ((direct.get(m) ?? 0) + cost <= 30 && !cyc(id, m) && m !== id) return m;
      for (const c of kidsOf.get(m) ?? []) q.push(c);
    }
    return null;
  };
  let overflow = 0;
  const heads = new Map();
  for (const [id, p] of placed)
    if (p.fac >= 0 && (p.rank ?? 2) <= 1 && !rulers.has(id))
      heads.set(`${p.fac}|${p.city}`, heads.get(`${p.fac}|${p.city}`) ?? id);
  const order = [...placed.entries()]
    .filter(([id, p]) => p.fac >= 0 && !rulers.has(id) && !parent.has(id))
    .sort((a, c) => (a[1].rank ?? 2) - (c[1].rank ?? 2));
  for (const [id, p] of order) {
    const fi = facInfo.get(p.fac);
    if (!fi) continue;
    const head = heads.get(`${p.fac}|${p.city}`);
    const start = head && head !== id ? head : fi.ruler;
    const m = fitUnder(start, id) ?? fitUnder(fi.ruler, id);
    if (m == null) {
      overflow++;
      continue;
    }
    const s = byId.get(id).stats;
    const rel = s && s[2] > s[1] ? 'STAFF' : s ? 'LIEUTENANT' : 'STAFF';
    addLink(id, m, rel, '규칙');
  }
  const officers = [...placed.entries()].map(([id, p]) => [
    id,
    p.fac >= 0 ? (idx.get(p.fac) ?? -1) : -1,
    p.city ?? '',
    p.src,
    p.auto ? 1 : 0,
    p.rank ?? 2,
    parent.get(id) ?? 0,
    { STAFF: 'S', LIEUTENANT: 'L', GUEST: 'G' }[relOf.get(id)] ?? '',
    basisOf.get(id) ?? '',
  ]);
  const linkStat = {
    sa: [...basisOf.values()].filter((v) => v === '사서').length,
    yj: [...basisOf.values()].filter((v) => v === '열전').length,
    ch: [...basisOf.values()].filter((v) => v === '추정').length,
    rec: [...basisOf.values()].filter((v) => v !== '규칙').length,
    rule: [...basisOf.values()].filter((v) => v === '규칙').length,
    overflow,
  };
  // 외교: 판별 지정이 먼저이고, 모드 판은 모드 값(동맹 칸, 적대 수치 70 이상)을 더한다.
  const DIP = [];
  {
    const oid = opt.id ?? `n${String(s.file).padStart(2, '0')}`;
    const seen = new Map();
    const add = (a, c, kind, src, quiet) => {
      if (a === c || a < 0 || c < 0) return;
      const k = a < c ? `${a}|${c}` : `${c}|${a}`;
      const prev = seen.get(k);
      if (prev) {
        if (prev[2] !== kind && !quiet) DIPERR.push(`${oid}: ${list[a].name}-${list[c].name} 동맹·전쟁 겹침`);
        return;
      }
      const row = [Math.min(a, c), Math.max(a, c), kind, src];
      seen.set(k, row);
      DIP.push(row);
    };
    const byName = (n) => list.findIndex((f) => f.name === n || byId.get(f.ruler)?.name === n);
    const extra = DIPLO[oid] ?? {};
    for (const [kind, rows] of [
      ['A', extra.A ?? []],
      ['W', extra.W ?? []],
    ])
      for (const [a, c, src] of rows) {
        const ia = byName(a),
          ic = byName(c);
        if (ia < 0 || ic < 0) {
          DIPERR.push(`${oid}: 세력 없음 ${ia < 0 ? a : c}`);
          continue;
        }
        add(ia, ic, kind, src ?? '추정');
      }
    if (!opt.id) {
      for (const [a, c] of MODALLY[s.file] ?? [])
        if (idx.has(a) && idx.has(c)) add(idx.get(a), idx.get(c), 'A', '모드', true);
      for (const [a, c] of MODREL[s.file]?.war ?? [])
        if (idx.has(a) && idx.has(c)) add(idx.get(a), idx.get(c), 'W', '모드', true);
    }
    // 추정으로 넣은 것은 사료 대조 결과로 근거를 바꾼다
    for (const row of DIP) {
      const na = list[row[0]].name,
        nc = list[row[1]].name;
      let cite = '';
      if (row[3] === '추정') {
        const v = verify(row[2], na, nc, oid);
        if (v) {
          row[3] = v[0];
          cite = v[1];
        } else DIPMISS.add(`${row[2]}|${na}·${nc}`);
      } else if (row[3] !== '모드') {
        const v = verify(row[2], na, nc, oid);
        if (v && v[0] === row[3]) cite = v[1];
        else DIPMISS.add(`글 없음 ${row[2]}|${na}·${nc}|${row[3]}`);
      }
      const key = `${row[2]}|${[na, nc].sort((p, q) => p.localeCompare(q, 'ko')).join('·')}|${row[3]}`;
      if (!DIPCLAIM.has(key))
        DIPCLAIM.set(key, {
          kind: row[2],
          pair: [na, nc].sort((p, q) => p.localeCompare(q, 'ko')).join('·'),
          src: row[3],
          cite,
          scen: [],
        });
      const c = DIPCLAIM.get(key);
      if (cite && !c.cite) c.cite = cite;
      c.scen.push(`${y}`);
    }
    DIP.sort((p, q) => (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : p[0] - q[0] || p[1] - q[1]));
  }
  const out = {
    id: opt.id ?? `n${String(s.file).padStart(2, '0')}`,
    file: opt.id ? null : s.file,
    type: opt.type ?? (IFID.has(s.file) ? 'IF' : '역사'),
    year: y,
    month: opt.month ?? s.month,
    title: opt.title ?? s.title,
    desc: opt.desc ?? null,
    premise: opt.premise ?? PREMISE[s.file],
    divergence: opt.divergence ?? null,
    source: opt.source ?? null,
    factions: list.map((f) => ({
      name: f.name,
      ruler: f.ruler,
      rulerLabel: f.rulerLabel,
      color: f.color,
      colorSrc: f.colorSrc,
      capital: f.capital,
      cities: f.cities,
      count: officers.filter((o) => o[1] === idx.get(f.fid)).length,
    })),
    diplomacy: DIP,
    owner: Object.fromEntries([...owner].filter(([, f]) => idx.has(f)).map(([c, f]) => [c, idx.get(f)])),
    owned: owner.size,
    inferred: [...fills],
    enclaveMoves: moved,
    total: sites.length,
    officers,
    alive: officers.length,
    fallback: fb,
    issues,
    linkStat,
    costs: officers.map((o) => costOf(byId.get(o[0]))),
  };
  result.push(out);
  return out;
};
for (const s of hsg.scen) build(s, { allEra: IFID.has(s.file) });
for (const def of IFS)
  build(
    hsg.scen.find((s) => s.file === def.base),
    { ...def, patchBase: true, patch: (ctx) => def.apply(ctx, { siteBy, nb }) },
  );
const specPath = `${S}/data/ai/scenarios.json`;
if (fs.existsSync(specPath)) {
  const specs = load(specPath);
  for (const sp of specs.scenarios) {
    const fx = SPECFIX[sp.id];
    if (fx) {
      for (const [f, l] of Object.entries(fx.drop ?? {})) {
        const cur = sp.cities?.[f];
        if (!cur) throw new Error(`SPECFIX ${sp.id} ${f}`);
        for (const c of l) {
          if (!cur.includes(c)) throw new Error(`SPECFIX ${sp.id} ${f} ${c}`);
        }
        sp.cities[f] = cur.filter((c) => !l.includes(c));
      }
      if (fx.absorb) sp.absorb = { ...(sp.absorb ?? {}), ...fx.absorb };
    }
    if (sp.id === 's0247' && !(sp.newFactions ?? []).some((f) => f.name === '구노국'))
      sp.newFactions = [...(sp.newFactions ?? []), { ruler: '히미쿠코', name: '구노국', key: 'guno', capital: '구노' }];
    if (sp.rulers && sp.year >= 224 && sp.year < 263)
      for (const [o, n] of Object.entries(sp.rulers))
        if (['장완', '비의', '비위'].includes(n)) {
          sp.rulers[o] = '유선';
          sp.factionName = { ...(sp.factionName ?? {}), [o]: '유선' };
        }
    const base = hsg.scen.find((s) => s.file === sp.base);
    if (!base) {
      specErrors.push(`${sp.id}: base 없음 ${sp.base}`);
      continue;
    }
    build(base, {
      id: sp.id,
      type: sp.type,
      year: sp.year,
      month: sp.month,
      title: sp.title,
      premise: sp.premise,
      desc: sp.desc,
      divergence: sp.divergence,
      source: sp.source,
      revive: sp.revive,
      exclude: sp.exclude,
      spec: sp,
    });
  }
  const descs = specs.descriptions ?? {};
  for (const r of result) if (descs[r.id]) r.desc = descs[r.id];
  for (const r of result)
    if (r.desc)
      r.desc = r.desc
        .replace(' 짧게 하북의 승자를 가리는 판이다.', ' 하북의 승자를 가리는 판이다.')
        .replace('조조의 뒤를 치는 짧고 빠른 판이고', '조조의 뒤를 치는 판이고');
}
console.log('MERGED', MERGED.join(' '));
console.log('DIPERR', DIPERR.length, DIPERR.join(' ; '));
console.log('DIPMISS', DIPMISS.size, [...DIPMISS].join(' ; '));
console.log('SPECERR', specErrors.length, specErrors.slice(0, 40).join(' ; '));
result.sort((a, b) => a.year - b.year || a.month - b.month);

// ── 5. 산출 ─────────────────────────────────────────────
const DESC2 = new Map((AI('D') ?? []).map((x) => [x.name, x.desc]));
const bioBase = new Map(load(`${S}/data/roster-bio.json`).map((x) => [x.id, x.bio]));
const bioByName = new Map(
  load(`${S}/data/roster-bio.json`)
    .filter((x) => x.bio)
    .map((x) => [x.name, x.bio]),
);
const data = {
  extraNames: extra.map((r) => r.name),
  sites: sites.map((s) => [
    s.name,
    +s.x.toFixed(1),
    +s.y.toFixed(1),
    s.kind,
    s.level,
    s.region,
    s.src,
    s.sanName ?? '',
    [hsg.desc[s.modName] ?? DESC2.get(s.name), s.note].filter(Boolean).join(' '),
    s.prov ?? '',
  ]),
  routes: [...edges.entries()].map(([k, v]) => [...k.split('|'), v]),
  land: basemap.land,
  lakes: basemap.lakes,
  rivers: riverPaths.map((r) => r.d),
  roster: allRoster.map((r) => [
    r.id,
    r.label,
    r.kanji ?? '',
    r.birth,
    r.death,
    r.lifeSource,
    r.tier,
    r.bio || bioBase.get(r.id) || (nameCount[r.name] === 1 ? bioByName.get(r.name) : '') || '',
    r.stats ?? null,
    r.statSrc ?? '',
  ]),
  scenarios: result,
  dipClaims: [...DIPCLAIM.values()].map((c) => ({ ...c, scen: [...new Set(c.scen)].sort() })),
  map: {
    fixes,
    conflicts,
    seaAdded: seaAdded,
    blockedGate,
    blockedRiver,
    fieldCount: fieldSites.length,
    total: sites.length,
    common: sites.filter((s) => s.src === '공통').length,
    merged: sites.filter((s) => s.src === '통합').length,
    mod: sites.filter((s) => s.src === '모드').length,
    san: sites.filter((s) => s.src === 'SAN10').length,
    field: fieldSites.length,
    levels: { small: levelLog.소.length, post: levelLog.진.length, smallNames: levelLog.소, postNames: levelLog.진 },
    fieldNames: fieldSites.map((f) => f.name),
    fieldMerged: FIELD_MERGE,
    added,
    absorbed,
    mergedNote,
    roads: edges.size,
    kept: keptRoads,
    gen,
    joined,
    rms: +Math.sqrt(resid.reduce((n, r) => n + r[0] ** 2, 0) / resid.length).toFixed(1),
    offLand: offLand.length,
  },
  coverage: {
    split: PIDSTAT.split,
    allTable: allTable.length,
    ai: { a: (AI('A') ?? []).length, g: gLinks.length },
    table: tableRoster.length,
    tableMatched,
    base: roster.length,
    matched: roster.filter((r) => r.inMod).length,
    extra: extra.length,
    cand: candidates.length,
    est: allRoster.filter((r) => r.lifeSource === '추정').length,
    z: allRoster.filter((r) => r.lifeSource === '삼국지10').length,
    core: allRoster.filter((r) => r.lifeSource === 'core2026').length,
    mod: allRoster.filter((r) => r.lifeSource === '모드').length,
  },
  candSample: candidates.slice(0, 120),
};
fs.writeFileSync(
  RETINUE_CHECK,
  JSON.stringify(
    result.map((s) => ({
      id: s.id,
      officers: s.officers.map((o, i) => ({ id: o[0], nation: o[1], master: o[6], rel: o[7], cost: s.costs[i] })),
    })),
  ),
);
for (const s of result) delete s.costs;
fs.writeFileSync(`${S}/data/data2.json`, JSON.stringify(data));
console.log('coverage', data.coverage, 'KB', Math.round(fs.statSync(`${S}/data/data2.json`).size / 1024));
for (const s of result) {
  const g = {};
  for (const i of s.issues) (g[i.k] ??= []).push(i.v);
  const free = s.officers.filter((o) => o[1] < 0).length;
  console.log(
    `[${s.id}] ${s.year}.${s.month} ${s.title}: 세력 ${s.factions.length} 거점 ${s.owned} 소속 ${s.alive - free} 재야 ${free} 추가배치 ${s.fallback}${
      Object.keys(g).length
        ? ' | ' +
          Object.entries(g)
            .map(([k, v]) => `${k}:${v.length}`)
            .join(' ')
        : ''
    }`,
  );
}
const b22 = result.find((x) => x.file === 22);
console.log(
  '49위',
  b22.factions.map((f) => `${f.name}(${f.capital}/${f.cities.length}): ${f.cities.join(' ')}`).join('\n'),
);
fs.writeFileSync(
  `${S}/data/draft2.json`,
  JSON.stringify({
    map: {
      version: 3,
      id: 'san10-v2',
      name: '통합 지도 초안',
      regionScheme: 'province-191',
      canvas: san.canvas,
      basemap: san.basemap,
      defaults: san.defaults,
      sites: sites.map((s, i) => {
        const b = sanBy.get(s.sanName ?? s.name);
        const key = 3000 + i;
        const level = Math.max(1, Math.min(8, s.level || 3));
        return s.kind === 'P'
          ? {
              id: `pass:${key}`,
              name: s.name,
              position: { x: Math.round(s.x), y: Math.round(s.y) },
              kind: 'PASS',
              anchorKey: key,
              region: s.region,
              defence: b?.defence ?? { initial: 1000, max: 8000 },
              wall: b?.wall ?? { initial: 1000, max: 8000 },
            }
          : {
              id: `city:${key}`,
              name: s.name,
              position: { x: Math.round(s.x), y: Math.round(s.y) },
              kind: 'CITY',
              anchorKey: key,
              level,
              region: s.region,
              initial: {
                population: level * 2500,
                agriculture: level * 50,
                commerce: level * 50,
                security: 100,
                defence: level * 250,
                wall: level * 250,
              },
              max: {
                population: level * 50000,
                agriculture: level * 1000,
                commerce: level * 1000,
                security: 2000,
                defence: level * 2000,
                wall: level * 2000,
              },
            };
      }),
      routes: [...edges.keys()].map((k, i) => {
        const [a, b] = k.split('|');
        const ia = sites.findIndex((x) => x.name === a),
          ib = sites.findIndex((x) => x.name === b);
        return {
          id: `route:v2-${i}`,
          from: `${sites[ia].kind === 'P' ? 'pass' : 'city'}:${3000 + ia}`,
          to: `${sites[ib].kind === 'P' ? 'pass' : 'city'}:${3000 + ib}`,
          mode: 'LAND',
          direction: 'BOTH',
          enabled: true,
        };
      }),
    },
    scenarios: result.map((x) => ({
      id: x.id,
      title: x.title,
      startYear: x.year,
      nation: x.factions
        .filter((f) => f.capital)
        .map((f) => [
          f.name.slice(0, 18),
          '#336699',
          100000,
          100000,
          x.title,
          1000,
          '병가',
          2,
          f.cities.length ? [f.capital, ...f.cities.filter((c) => c !== f.capital)] : [],
        ]),
      general: x.officers.map(([id, fi, city]) => {
        const r = byId.get(id);
        const st = r.stats ?? [50, 50, 50, 50, 50];
        return [
          1,
          r.label,
          `p/${id}.jpg`,
          fi + 1,
          city || null,
          st[0],
          st[1],
          st[2],
          0,
          r.birth ?? 150,
          Math.max(r.death ?? 300, r.birth ?? 150),
          '유지',
          null,
        ];
      }),
      diplomacy: (() => {
        const num = new Map();
        let k = 0;
        x.factions.forEach((f, i) => {
          if (f.capital) num.set(i, ++k);
        });
        return x.diplomacy
          .filter(([a, c]) => num.has(a) && num.has(c))
          .map(([a, c, kind]) => [num.get(a), num.get(c), kind === 'W' ? 0 : 7, kind === 'W' ? 0 : 24]);
      })(),
    })),
  }),
);
