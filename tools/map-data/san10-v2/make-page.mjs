// 최신 data2.json과 구역·검증 결과로 기획 페이지를 만든다.
import fs from 'node:fs';
import { patchDiplo } from './diplo-ui.mjs';
import os from 'node:os';
import path from 'node:path';
import { S } from './paths.mjs';
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const data = load(`${S}/data/data2.json`);
const check = load(`${S}/data/validate3.json`);
const perf = load(`${S}/data/perf.json`);
const zoneData = load(`${S}/data/zones.json`);
const statMeta = load(`${S}/data/stats-meta.json`);
data.zones = zoneData.zones;
const { sources: SOURCES, cards } = load(`${S}/data/page-fragments.json`);

let tpl = fs.readFileSync(new URL('./page-template.html.tpl', import.meta.url), 'utf8');
const rep = (a, c) => {
  if (!tpl.includes(a)) throw new Error('template: ' + a.slice(0, 70));
  tpl = tpl.split(a).join(c);
};
// 색 토큰
rep(
  '--src-san: #c9822f;\n  --display',
  '--src-san: #c9822f; --src-field: #b23a48; --zone-empty: #dfe2d6; --zone-line: #66716b;\n  --display',
);
rep(
  '--src-san: #e6a65c; color-scheme: dark',
  '--src-san: #e6a65c; --src-field: #ec7f8c; --zone-empty: #2f393d; --zone-line: #0d1315; color-scheme: dark',
);
rep('* { box-sizing: border-box }', '* { box-sizing: border-box }\n[hidden] { display: none !important }');
tpl = tpl.replace(/\.field text \{[^\n]*\n/, '').replace(/\.samples img \{[^\n]*\n/, '');
rep(
  '.road { stroke: var(--route); stroke-width: .9 } .road.owned { stroke-width: 1.6 }',
  '.zone { stroke: var(--zone-line); stroke-width: .6px; vector-effect: non-scaling-stroke; cursor: pointer } .zone.sel { stroke: var(--ink); stroke-width: 2px } .dim .zone.fade { opacity: .25 }\n.road { stroke: var(--route); stroke-width: .9; pointer-events: none } .road.owned { stroke: var(--ink); stroke-opacity: .32; stroke-width: 1 }',
);
// 전장 표식 제거
tpl = tpl.replace(/ {2}const fg = el\('g', \{\}, svg\);\n {2}fieldNodes = [^\n]*\n/, '');
rep(', fieldNodes = [], view', ', view');
tpl = tpl.replace(/ {2}for \(const f of fieldNodes\) \{[^\n]*\n/, '');
// 구역: 땅 위에 깔고 해안선으로 자른다
rep(
  "  for (const d of D.lakes ?? []) el('path', { d, class: 'lake' }, svg);\n",
  `  const defs = el('defs', {}, svg);
  const clip = el('clipPath', { id: 'landclip' }, defs);
  for (const d of D.land) el('path', { d }, clip);
  const zg = el('g', { 'clip-path': 'url(#landclip)' }, svg);
  for (const [name, d] of D.zones) { if (!d) continue; const z = el('path', { d, class: 'zone', 'fill-rule': 'evenodd' }, zg); zoneEl.set(name, z); el('title', {}, z).textContent = name; z.addEventListener('click', () => { csel = csel === name ? null : name; fsel = null; paint(); }); }
  for (const d of D.lakes ?? []) el('path', { d, class: 'lake' }, svg);
`,
);
rep(
  'const main = D.sites.filter(',
  "const zoneEl = new Map(), zoneArea = new Map(D.zones.map((z) => [z[0], z[2]]));\nconst LEVEL = { 1: '수', 2: '진', 3: '관문', 4: '이', 5: '소', 6: '중', 7: '대', 8: '특' };\nconst main = D.sites.filter(",
);
rep(
  "const shape = s[3] === 'P' ? el('rect', { x: -3.5, y: -3.5, width: 7, height: 7 }, g) : el('circle', { r }, g);",
  "const shape = s[3] === 'P' ? el('rect', { x: -3.5, y: -3.5, width: 7, height: 7 }, g) : s[6] === '전장' ? el('rect', { x: -3, y: -3, width: 6, height: 6, transform: 'rotate(45)' }, g) : el('circle', { r }, g);",
);
rep(
  "    n.g.classList.toggle('sel', csel === name);\n",
  `    n.g.classList.toggle('sel', csel === name);
    const z = zoneEl.get(name);
    if (z) {
      z.setAttribute('fill', mode === 'faction' ? (f ? f.color : 'var(--zone-empty)') : SRCCOL[n.src]);
      z.setAttribute('fill-opacity', mode === 'faction' ? (f ? 0.55 : 1) : 0.45);
      z.classList.toggle('sel', csel === name);
      z.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel);
    }
`,
);
rep("    r.e.style.stroke = same ? cur.factions[a].color : '';\n", '');
rep('<span>● 도시 · ■ 관문</span>', '<span>칠한 면 = 거점의 육지 구역</span><span>● 도시 · ■ 관문 · ◆ 전장(진)</span>');
rep('<span>× = 전장</span>', '');
rep('<span>빈 표식 = 공백지</span>', '<span>회색 구역 = 공백지</span>');
rep("SAN10: 'var(--src-san)' };", "SAN10: 'var(--src-san)', 전장: 'var(--src-field)' };");
rep(
  'SAN10에서 유지 ${D.map.san}</span>`',
  'SAN10에서 유지 ${D.map.san}</span><span><i class="key" style="background:var(--src-field)"></i>전장 ${D.map.field}</span>`',
);
rep("SAN10: 'SAN10에서 유지' }[s[6]]", "SAN10: 'SAN10에서 유지', 전장: '전장' }[s[6]]");
rep(
  "${oi === undefined ? '공백지' : esc(cur.factions[oi].name)} · ${srcName}",
  "${oi === undefined ? '공백지' : esc(cur.factions[oi].name)}${cur.inferred.includes(csel) ? '(모드에 없는 거점: 가까운 모드 도시를 따름)' : ''} · 규모 ${LEVEL[s[4]] ?? s[4]} · 구역 ${zoneArea.get(csel) ?? 0}칸 · ${srcName}",
);
// 인물 능력치
rep(
  "<p>${esc(r[7] || '설명 없음')}</p>",
  "<p>${r[8] ? `통솔 ${r[8][0]} · 무력 ${r[8][1]} · 지력 ${r[8][2]} · 정치 ${r[8][3]} · 매력 ${r[8][4]} <span style=\"color:var(--muted)\">(${r[9] === '모드' ? '모드 값' : '열전 기준 산정'})</span>` : ''}</p><p>${esc(r[7] || '설명 없음')}</p>",
);
// 지금은 대부분 새 판이라 표시를 없앤다
rep("${s.id.startsWith('g') ? '<span class=\"new\">신규</span>' : ''}", '');
rep(" : '기준 세력도: N24022')", " : '')");
rep(
  '거점 ${cur.owned}곳 중 ${cur.inferred.length}곳은 도로 이웃에서 소유를 추정했습니다(점선 테두리).',
  '공백지 ${cur.total - cur.owned}곳은 모드 값 그대로입니다. 소유 ${cur.owned}곳 중 ${cur.inferred.length}곳은 모드에 없는 거점이라 길로 가장 가까운 모드 도시를 따랐습니다(점선 테두리).',
);
rep(
  '검토용 초안입니다. 게임 데이터는 바꾸지 않았습니다.',
  '검토용 초안입니다. 저장소의 게임 데이터는 바꾸지 않았습니다.',
);

// 동맹 표시
rep(
  '<h3 style="margin-top:12px">초안 검사</h3>',
  '<h3 style="margin-top:12px">동맹</h3><div id="ally"></div><h3 style="margin-top:12px">초안 검사</h3>',
);
rep(
  '  const g = {}; for (const it of cur.issues)',
  '  { const al = cur.alliances; const note = cur.allianceNote ? `<p class="ok">${esc(cur.allianceNote)}</p>` : \'\'; const by = new Map(); for (const [a, c] of al ?? []) { for (const [x, y] of [[a, c], [c, a]]) { if (!by.has(x)) by.set(x, []); by.get(x).push(y); } } $(\'ally\').innerHTML = al === null ? \'<p class="ok">새로 만든 판이라 동맹 값이 없습니다.</p>\' : !al.length ? \'<p class="ok">이 판에는 동맹이 없습니다.</p>\' : `<ul class="issues">${[...by.entries()].sort((p, q) => q[1].length - p[1].length || p[0] - q[0]).map(([x, ys]) => `<li><span class="sw" style="background:${cur.factions[x].color}"></span>${esc(cur.factions[x].name)} — ${ys.map((y) => esc(cur.factions[y].name)).join(\', \')}</li>`).join(\'\')}</ul>${note}`; }\n  const g = {}; for (const it of cur.issues)',
);
rep(
  '  const owner = cur.owner, inf = new Set(cur.inferred);',
  '  const owner = cur.owner, inf = new Set(cur.inferred);\n  const al = new Set(fsel === null ? [] : (cur.alliances ?? []).filter((p) => p.includes(fsel)).map((p) => (p[0] === fsel ? p[1] : p[0])));',
);
{
  const k = 'fsel !== null && oi !== fsel)';
  if (tpl.split(k).length < 3) throw new Error('fade 자리');
  tpl = tpl.split(k).join('fsel !== null && oi !== fsel && !al.has(oi))');
}
// 짧은 판·긴 판 구분은 없앤다
rep("${cur.short ? '<span class=\"tag\">짧은 판</span>' : ''}", '');
rep("(cur.short ? `원작 짧은 판: ${esc(cur.short[0])}, ${esc(cur.short[1])}. ` : '') + ", '');
rep("${s.short ? '·짧은 판' : ''}", '');
rep('<span>점선 테두리 = 소유 추정</span>', '<span>점선 테두리 = 모드에 없는 거점</span>');
rep('<th class="num">거점</th>', '<th class="num">거점</th><th class="num">공백지</th>');
rep('<td class="num">${s.owned}</td>', '<td class="num">${s.owned}</td><td class="num">${s.total - s.owned}</td>');
if (tpl.includes('짧은 판') || tpl.includes('.short')) throw new Error('short 잔여');

tpl = patchDiplo(tpl);

const m = data.map,
  c = data.coverage,
  scen = data.scenarios;
const MODX = load(`${S}/data/mod-ext.json`);
const splitN = c.split ?? 0;
const modScen = scen.filter((s) => s.file);
const mod184 = MODX[1];
const modBlank184 = mod184.own.filter((f) => f < 0).length;
const modFac184 = new Set(mod184.own.filter((f) => f >= 0)).size;
let actN = 0,
  actBad = 0;
for (const k of Object.keys(MODX))
  for (const r of [...MODX[k].n24, ...MODX[k].rows]) {
    if (r[2] !== 0 || r[5] === 65535 || r[6] === 65535) continue;
    actN++;
    if (MODX[k].own[r[6]] !== r[5]) actBad++;
  }
const extPeople = new Set(Object.values(MODX).flatMap((x) => x.rows.map((r) => r[8]))).size;
const colorNames = {};
for (const s of scen) for (const f of s.factions) (colorNames[f.colorSrc ?? '자동'] ??= new Set()).add(f.name);
const colorCount = Object.fromEntries(Object.entries(colorNames).map(([k, v]) => [k, v.size]));
const dipAll = scen.flatMap((s) => s.diplomacy.map((d) => [s, d]));
const dipCount = (kind, src) => dipAll.filter(([, d]) => d[2] === kind && (!src || d[3] === src)).length;
const dipLine = (s, kind) => {
  const deg = new Map();
  for (const [x, y] of s.diplomacy) {
    deg.set(x, (deg.get(x) ?? 0) + 1);
    deg.set(y, (deg.get(y) ?? 0) + 1);
  }
  const by = new Map();
  for (const [x, y, k] of s.diplomacy) {
    if (k !== kind) continue;
    const hub = (deg.get(x) ?? 0) > (deg.get(y) ?? 0) || ((deg.get(x) ?? 0) === (deg.get(y) ?? 0) && x < y) ? x : y;
    const o = hub === x ? y : x;
    if (!by.has(hub)) by.set(hub, []);
    by.get(hub).push(o);
  }
  return (
    [...by.entries()]
      .sort((p, q) => q[1].length - p[1].length)
      .map(([h, os]) => `${s.factions[h].name}–${os.map((o) => s.factions[o].name).join('·')}`)
      .join(', ') || '없음'
  );
};
const dipRows = scen
  .map(
    (s) =>
      `<tr><td><a data-go="${s.id}">${s.year}년 ${s.title}</a></td><td>${s.type}</td><td>${dipLine(s, 'A')}</td><td>${dipLine(s, 'W')}</td></tr>`,
  )
  .join('\n');
const dipAdded = scen
  .filter((s) => s.file && s.diplomacy.some((d) => d[3] !== '모드'))
  .map((s) => `${s.year}년 ${s.title}`);
const claimRows = (src) =>
  data.dipClaims
    .filter((c) => c.src === src)
    .sort((p, q) => (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : p.pair.localeCompare(q.pair, 'ko')))
    .map(
      (c) =>
        `<tr><td>${c.kind === 'A' ? '동맹' : '전쟁'}</td><td>${c.pair}</td><td>${c.scen.length > 3 ? `${c.scen[0]}~${c.scen[c.scen.length - 1]}년 ${c.scen.length}개 해` : c.scen.join('·') + '년'}</td><td>${c.cite}</td></tr>`,
    )
    .join('\n');
const claimN = (src) => data.dipClaims.filter((c) => c.src === src).length;
const claimTable = (src) =>
  `<div class="scroll"><table class="dt"><thead><tr><th>종류</th><th>세력</th><th>판</th><th>근거</th></tr></thead><tbody>\n${claimRows(src)}\n</tbody></table></div>`;
const dipEmpty = scen.filter((s) => !s.diplomacy.length).map((s) => `${s.year}년 ${s.title}`);
const dropped = scen.flatMap((s) =>
  s.issues.filter((i) => i.k === '땅이 없어 뺀 세력').map((i) => `${s.title}: ${i.v}`),
);
const blankRange = modScen.map((s) => MODX[s.file].own.filter((f) => f < 0).length);
const KPOL = ['고구려', '부여', '신라', '백제', '가야', '왜', '구노국'];
const inferredOf = (s) => new Set(s.inferred);
const korRows = KPOL.map((nm) => {
  const hits = modScen.map((s) => [s, s.factions.find((f) => f.name === nm)]).filter(([, f]) => f);
  if (!hits.length) return '';
  const rulers = [];
  for (const [s, f] of hits) {
    const r = data.roster.find((x) => x[0] === f.ruler)[1];
    if (!rulers.some((x) => x[0] === r)) rulers.push([r, s.year]);
  }
  const land = ([s, f]) => `${s.year}년 ${f.cities.filter((x) => !inferredOf(s).has(x)).join('·')}`;
  return `<tr><td>${nm}</td><td>${rulers.map(([r, y]) => `${r}(${y}~)`).join(', ')}</td><td>${land(hits[0])}${hits.length > 1 ? ` → ${land(hits[hits.length - 1])}` : ''}</td></tr>`;
}).join('\n');
const hist = scen.filter((s) => s.type === '역사').length,
  ifs = scen.filter((s) => s.type === 'IF').length;
const n = (v) => v.toLocaleString('ko-KR');
const sum = (k) => scen.reduce((t, s) => t + s.linkStat[k], 0);
const total = data.roster.length;
const modStats = data.roster.filter((r) => r[9] === '모드').length;
const estStats = data.roster.filter((r) => r[9] === '추정').length;
const enclaves = scen.flatMap((s) => s.issues.filter((i) => i.k === '월경지').map((i) => i.v));
const routeKinds = data.routes.reduce((o, r) => ((o[r[2]] = (o[r[2]] ?? 0) + 1), o), {});
const NF = new Set(['낙랑', '대방', '기리영']);
const mainland = data.sites.filter((s) => s[5] !== 15 && s[5] !== 16 && !NF.has(s[0]));
const blanks = scen.map((x) => [x, mainland.filter((s) => x.owner[s[0]] === undefined).length]);
const stillBlank = blanks.filter(([, k]) => k > 0).map(([x, k]) => `${x.title} ${k}곳`);
const avgInferred = Math.round(scen.reduce((t, s) => t + s.inferred.length, 0) / scen.length);
const levelCount = data.sites.filter((s) => s[3] === 'C').reduce((o, s) => ((o[s[4]] = (o[s[4]] ?? 0) + 1), o), {});
const [cur, next] = perf;
const ratio = Math.round(next.msPerYear / cur.msPerYear);
const zs = zoneData.stat;
const claimedPct = Math.round((zs.claimed / zs.landCells) * 100);
const coverage = [
  { label: '초상이 있는 opensamguk-images', n: c.base, c: 'var(--src-mod)' },
  { label: '모드 인물 표에서 추가', n: c.table, c: 'var(--src-merge)' },
  { label: '시나리오에만 있는 인물', n: c.extra, c: 'var(--src-san)' },
];

const html = `
<section><h2>지금 상태</h2>
<p>후삼국지 삼국지편을 기준으로 지도와 명단을 다시 만들고, 역사 ${hist}종과 IF ${ifs}종을 얹은 구현 전 초안입니다. 저장소에는 아직 아무것도 넣지 않았습니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>항목</th><th class="num">수</th><th>내용</th></tr></thead><tbody>
<tr><td>거점</td><td class="num">${m.total}</td><td>전장 ${m.field}곳 포함. 코드 한도 500곳 안입니다. 모든 거점에 육지 구역이 있습니다.</td></tr>
<tr><td>도로</td><td class="num">${m.roads}</td><td>코드 한도 2,000개 안입니다.</td></tr>
<tr><td>시나리오</td><td class="num">${scen.length}</td><td>역사 ${hist}, IF ${ifs}. 모두 설명이 있습니다.</td></tr>
<tr><td>인물</td><td class="num">${n(total)}</td><td>능력치는 모드 값 ${n(modStats)}명, 열전 기준 산정 ${n(estStats)}명입니다.</td></tr>
<tr><td>휘하 관계</td><td class="num">${n(check.retinueLinks)}</td><td>${scen.length}개 시나리오를 합친 건수입니다.</td></tr>
</tbody></table></div></section>
<section><h2>거점 구역</h2>
<p>지도의 칠한 면이 거점마다 가진 육지 구역입니다. 나중에 구역 안을 더 잘게 나눌 수 있도록 1단위 격자 자료도 함께 만들어 두었습니다. 세부 분할은 아직 하지 않았습니다.</p>
<ul>
<li><b>나누는 방법:</b> 거점에서 땅을 따라 거리를 재서 가장 가까운 거점의 땅으로 삼습니다. 규모가 클수록 조금 더 멀리 닿고, 장강·황하를 건너려면 ${zs.river}단위를 더 칩니다. 바다는 건너지 않습니다.</li>
<li><b>길쭉한 구역:</b> 거점이 양옆 이웃 사이에 끼면 빈 땅 쪽으로 곧은 띠가 뻗습니다. 자기 넓이에 비해 너무 멀리 나간 땅은 맞닿은 이웃에게 넘깁니다. 받을 이웃이 없는 반도와 회랑은 실제로 긴 땅이라 그대로 둡니다. 강 칸을 따라 뻗는 것도 비싸게 쳐서 막았습니다. 길이가 폭의 5배를 넘는 구역은 2곳에서 0곳이 됐습니다.</li>
<li><b>닿는 거리:</b> 거점에서 ${zs.reach}단위까지입니다. 그래서 몽골 고원, 티베트, 시베리아 같은 먼 땅은 어느 구역에도 들지 않습니다. 바탕 지도 땅의 ${claimedPct}%가 구역에 듭니다.</li>
<li><b>한계:</b> 산맥을 고려하지 않아 경계가 산줄기를 따르지 않습니다. 바탕 지도의 고도 자료는 화면용 그림뿐이라 계산에 쓰지 못했습니다. 넓은 변경 구역(${zs.biggest
  .slice(0, 3)
  .map((x) => x.split(':')[0])
  .join(', ')})과 전장처럼 좁은 구역의 넓이 차이도 아직 조정하지 않았습니다.</li>
</ul></section>
<section><h2>공백지와 도시 소유</h2>
<p>도시 소유는 모드 값을 그대로 씁니다. 공백지는 공백지로 둡니다. 이전 판은 「모드에 소유 표가 없다」고 보고 인물이 있는 도시로 소유를 계산한 뒤 빈 곳을 주변 세력으로 채웠습니다. 전제와 채우기가 모두 틀렸습니다.</p>
<ul>
<li><b>소유 표의 위치:</b> 시나리오 파일 N24001~30 끝의 도시 표(51곳)와 <code>hsg_event_state</code> 폴더의 시나리오별 확장 파일(CX44 구역, 199곳)에 도시마다 세력 번호가 있습니다. 공백지는 번호가 비어 있습니다. KOEICDA.DLL에는 소유 값이 없습니다.</li>
<li><b>화면 대조:</b> 184년 황건의 난은 모드 도시 250곳 중 ${modFac184}세력이 ${250 - modBlank184}곳을 갖고 ${modBlank184}곳이 공백지입니다. 세력 구성은 게임의 군주 선택 화면과 같습니다(장각·하진·손견 등 25명).</li>
<li><b>내부 대조:</b> 모드 30판에서 세력에 속해 활동 중인 인물 ${n(actN)}명 가운데 자기 세력 소유가 아닌 도시에 있는 사람은 ${actBad}명입니다. 소유 표와 인물 표가 서로 맞습니다.</li>
<li><b>확장 세력:</b> 번호 27 이상인 세력(고구려·부여·신라·백제·가야·왜, 선비·흉노·오환, 장막·포신·장연 등)의 군주는 확장 인물 표에 있습니다. 이전 판은 이 표를 읽지 않아 이 세력들이 빠지거나 손으로 세워져 있었습니다.</li>
<li><b>모드에 없는 거점 ${m.san + m.field}곳:</b> SAN10에서 유지한 ${m.san}곳과 전장 ${m.field}곳은 모드에 소유 값이 없습니다. 길로 가장 가까운 모드 도시를 따르고, 그 도시가 공백지면 같이 공백지로 둡니다. 지도에서 점선 테두리로 구분하며 판마다 평균 ${avgInferred}곳입니다.</li>
<li><b>새로 만든 ${scen.length - modScen.length}판:</b> 기준으로 삼은 모드 판의 소유 표에서 출발해 판별 지정(도시 넘김, 공백지, 세력 흡수)만 얹습니다. 주변 세력으로 채우는 단계와 끊긴 영토를 잇는 단계는 없앴습니다. 지정 때문에 땅이 하나도 남지 않은 세력은 세우지 않습니다. 처음에는 8개 판 17건이 그렇게 빠졌고, 사료와 대조해 아래처럼 정리했습니다. 지금 남은 것은 ${dropped.length}건입니다(${dropped.join(', ')}).</li>
</ul>
<h3>빠졌던 확장 세력 17건의 재검토</h3>
<div class="scroll"><table class="dt"><thead><tr><th>세력</th><th>판</th><th>처리</th><th>근거</th></tr></thead><tbody>
<tr><td>송건</td><td>185년 흑산과 양주 봉기</td><td>포한을 한수에게 넘긴 지정을 지우고 세력을 되살림</td><td>「隴西宋建自稱河首平漢王,聚衆枹罕,改元,置百官,三十餘年」 三國志 卷1</td></tr>
<tr><td>유총</td><td>185·188·189.8·195.6년 네 판</td><td>진을 하진·조조에게 넘긴 지정을 지우고 세력을 되살림</td><td>「陳王寵有勇,善弩射。黃巾賊起,寵治兵自守」 資治通鑑 卷62, 「袁術殺陳王寵」 後漢書 卷9(197년)</td></tr>
<tr><td>선우보</td><td>199.6년 역경 함락 뒤</td><td>어양을 원소에게 넘긴 지정을 지우고 세력을 되살림</td><td>「漁陽田豫說太守鮮于輔曰:曹氏奉天子以令諸侯…宜早從之」 資治通鑑 卷63</td></tr>
<tr><td>창희</td><td>200.1년 허도의 정변</td><td>동해를 조인에게 넘긴 지정을 지우고 세력을 되살림</td><td>「東海昌霸反,郡縣多叛曹公為先主」 三國志 卷32</td></tr>
<tr><td>곽태·주포</td><td>188.3년 주목의 시대, 225.3년 제갈량의 남정</td><td>판 지정이 같은 군주로 세력을 하나 더 세워 모드 세력이 밀려났던 것. 하나로 합침</td><td>「黃巾餘賊郭大等起於西河白波谷」 後漢書 卷8, 「牂牁太守朱褒擁郡反」 三國志 卷33</td></tr>
<tr><td>포신·원유·초화</td><td>188.3년, 189.8년 두 판</td><td>독립 세력으로 세우지 않고 하진(조정) 소속으로 옮김</td><td>포신은 「進府掾王匡,騎都尉鮑信…進使還鄉里募兵」 資治通鑑 卷59. 원유·초화는 190년 거병 기록만 찾았고 그 전 소속은 같은 규칙을 따른 것(미검증)</td></tr>
<tr><td>오거</td><td>209.2년 곽가의 적벽(IF)</td><td>유비가 창오로 밀려난 판이라 유비 휘하로 옮김</td><td>「與蒼梧太守吳巨有舊,欲往投之」 三國志 卷32. 휘하로 든다는 것은 판 설정에 맞춘 추정</td></tr>
<tr><td>곽태</td><td>189.8년 하진의 궁중 숙청(IF)</td><td>그대로 뺌. 인물은 평양에 재야로 둠</td><td>이 판은 동탁을 하동에 두는데 모드의 평양이 곧 하동이라 한 거점을 둘이 가질 수 없음. 「白波賊寇河東」 後漢書 卷9는 189년 10월</td></tr>
</tbody></table></div>
<ul>
</ul>
<p>모드 30판의 공백지는 모드 도시 250곳 기준으로 ${Math.min(...blankRange)}~${Math.max(...blankRange)}곳입니다. 영웅 집결 두 판이 가장 많습니다. 판별 수는 아래 전체 목록의 공백지 칸(전체 ${m.total}곳 기준)에 있습니다.</p></section>
<section><h2>세력색</h2>
<p>나무위키 「삼국지 시리즈/상징색」에 있는 세력은 그 색을 쓰고, 없는 세력은 후삼국지의 색을 씁니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>출처</th><th class="num">세력</th><th>내용</th></tr></thead><tbody>
<tr><td>나무위키 상징색</td><td class="num">${colorCount['나무위키'] ?? 0}</td><td>삼국지 14 값을 씁니다. 14에 안 나오는 세력은 가장 늦은 작품의 값입니다(장연 13, 교모 6, 한수 8). 후계와 잔당은 같은 색입니다(조위·진, 촉한, 손오, 원소·원상, 황건 잔당 등).</td></tr>
<tr><td>후삼국지</td><td class="num">${colorCount['후삼국지'] ?? 0}</td><td>게임이 실제로 그리는 색입니다. 0~20번 칸은 실행 파일의 판별 색 번호 표(1~23번 판)와 <code>MIDLEMAP.S6</code>의 도시 상자 그림에서, 22번 칸 이상(이민족·확장 세력)은 <code>N244MID.S6</code>의 칸별 상자 그림 106장에서 읽었습니다. 색은 <code>PALETTE.S6</code>로 풀었습니다. ${[...(colorNames['후삼국지'] ?? [])].join(', ')}.</td></tr>
<tr><td>자동</td><td class="num">${colorCount['자동'] ?? 0}</td><td>새로 만든 판에만 군주로 나와 후삼국지에 색이 없는 세력입니다. 임시 색입니다. ${[...(colorNames['자동'] ?? [])].join(', ')}.</td></tr>
</tbody></table></div>
<ul>
<li><b>대조:</b> 184년 판 25세력의 색이 군주 선택 화면과 같습니다(구역거 황갈색, 번임 검정, 송건 자홍, 고구려 자주, 가야 연녹색 등).</li>
<li><b>칸마다 정해진 색:</b> 22번 칸 이상은 군주가 아니라 세력 칸에 색이 붙어 있습니다. 그래서 같은 색을 다른 판의 다른 세력이 쓰기도 합니다(33번 칸: 화련, 괴두, 구노국).</li>
<li><b>읽지 못한 곳:</b> 24~30번 판의 0~20번 칸은 실행 파일 표에 줄이 없어, 같은 군주가 다른 판에서 쓴 색을 따랐습니다. 영웅 집결 두 판도 같은 방식입니다.</li>
</ul></section>
<section><h2>외교 관계</h2>
<p>90판 모두에 동맹과 전쟁 상태를 넣었습니다. 동맹 ${dipCount('A')}쌍, 전쟁 ${dipCount('W')}쌍입니다. 시나리오 화면의 세력 배치 아래 「외교」에 나오고, 세력을 고르면 동맹 세력은 밝게, 전쟁 상대는 붉은 테두리로 보입니다. 모드 값이 아닌 것은 목록에 근거 딱지가 붙습니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>근거</th><th class="num">동맹</th><th class="num">전쟁</th><th>내용</th></tr></thead><tbody>
<tr><td>모드</td><td class="num">${dipCount('A', '모드')}</td><td class="num">${dipCount('W', '모드')}</td><td>동맹은 세력 표(N24001~30 끝, 0~26번 칸)의 동맹 칸입니다. 전쟁은 같은 표의 적대 수치가 한쪽이라도 70 이상인 쌍입니다. 27번 칸 이상인 확장 세력의 기록(<code>FW12</code> 구역)은 관계 칸이 30판 모두 비어 있습니다.</td></tr>
<tr><td>사료</td><td class="num">${dipCount('A', '사료')}</td><td class="num">${dipCount('W', '사료')}</td><td>사료 색인에서 원문을 확인했습니다. 서로 다른 주장으로는 ${claimN('사료')}건이고 아래 표에 문장과 권을 적었습니다.</td></tr>
<tr><td>연의</td><td class="num">${dipCount('A', '연의')}</td><td class="num">${dipCount('W', '연의')}</td><td>반동탁 연합의 18제후 가운데 정사 명단에 없는 세력입니다(三國演義 第五回). 장양은 이 판에 세력이 없어 빠졌습니다.</td></tr>
<tr><td>모드 준용</td><td class="num">${dipCount('A', '모드 준용')}</td><td class="num">${dipCount('W', '모드 준용')}</td><td>가까운 모드 판의 값을 시기만 옮겨 썼습니다. 황건 판의 하진과 지방관 동맹, 황건과 관군의 전쟁, 관도 판의 원소·공손도 동맹 등입니다.</td></tr>
<tr><td>판 설정</td><td class="num">${dipCount('A', '판 설정')}</td><td class="num">${dipCount('W', '판 설정')}</td><td>IF 판에서 갈라진 뒤의 설정에서 나온 관계라 사료로 확인할 대상이 아닙니다.</td></tr>
<tr><td>추정</td><td class="num">${dipCount('A', '추정')}</td><td class="num">${dipCount('W', '추정')}</td><td>원문을 찾지 못했거나 사서의 표현과 딱 맞지 않습니다(미검증). 아래에 이유를 적었습니다.</td></tr>
</tbody></table></div>
<ul>
<li><b>대조 방법:</b> 추정으로 넣었던 ${claimN('사료') + claimN('모드 준용') + claimN('판 설정') + claimN('추정')}건의 주장을 三國志·後漢書·資治通鑑·晉書 색인에서 한 건씩 찾았습니다. 반복되는 관계는 한 번만 확인했습니다(촉오 동맹, 유장·장로 등).</li>
<li><b>대조로 바뀐 것:</b> 손책과 유표의 전쟁은 실제 싸움이 199년이라 195~197년 판은 모드 준용으로 내렸습니다. 발기가 의탁한 상대는 사서에 공손강으로 적혀 있습니다. 기리영을 친 쪽은 사서에 한이라고만 나와 백제로 본 것은 추정으로 뒀습니다.</li>
<li><b>모드 판 30종:</b> 모드 값은 그대로 두고 비어 있거나 어색한 곳만 더했습니다. 더한 판은 ${dipAdded.length}종입니다.</li>
<li><b>전쟁 기준:</b> 모드의 적대 수치는 양쪽이 다를 수 있습니다(관도 판의 손책→유표 75, 유표→손책 35). 한쪽이라도 70 이상이면 전쟁으로 봤습니다. 70이라는 선은 제가 정한 것입니다.</li>
<li><b>영웅 집결 두 판:</b> 모드 값 그대로입니다. 220년 판은 조예가 조환·사마염·손호와 동맹이고 유선이 나머지와 전쟁입니다.</li>
<li><b>저장소 형식:</b> 게임의 초기 외교는 전쟁·선포·불가침 세 가지입니다. 초안에는 전쟁은 전쟁으로, 동맹은 불가침 24개월로 넣었습니다. 24개월은 임시값입니다.</li>
${dipEmpty.length ? `<li><b>외교가 없는 판:</b> ${dipEmpty.join(', ')}.</li>` : ''}
</ul>
<h3>추정으로 남은 ${claimN('추정')}건</h3>
${claimTable('추정')}
<h3>사료로 확인한 ${claimN('사료')}건</h3>
${claimTable('사료')}
<h3>연의 ${claimN('연의')}건 · 모드 준용 ${claimN('모드 준용')}건 · 판 설정 ${claimN('판 설정')}건</h3>
${claimTable('연의')}
${claimTable('모드 준용')}
${claimTable('판 설정')}
<h3>판별 목록</h3>
<div class="scroll"><table class="dt"><thead><tr><th>판</th><th>종류</th><th>동맹</th><th>전쟁</th></tr></thead><tbody>
${dipRows}
</tbody></table></div></section>
<section><h2>지도</h2>
<p>시나리오 탭의 「거점 출처 보기」를 누르면 아래 구분이 지도에 색으로 나옵니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>구분</th><th class="num">곳</th><th>처리</th></tr></thead><tbody>
<tr><td>두 지도 공통</td><td class="num">${m.common}</td><td>현행 좌표와 규모를 씁니다.</td></tr>
<tr><td>같은 곳·표기 통합</td><td class="num">${m.merged}</td><td>${m.mergedNote.join(', ')}. 삼한·왜 표기는 D-050을 따릅니다.</td></tr>
<tr><td>모드에서 추가</td><td class="num">${m.mod}</td><td>모드 좌표를 공통 지명에 맞춰 옮겼습니다.</td></tr>
<tr><td>SAN10에서 유지</td><td class="num">${m.san}</td><td>${m.added.join(', ')}</td></tr>
<tr><td>전장</td><td class="num">${m.field}</td><td>${m.fieldNames.join(', ')}</td></tr>
</tbody></table></div>
<h3>규모</h3>
<ul>
<li><b>모드 추가 ${m.mod}곳:</b> D-052·D-055대로 나눴습니다. 군국 치소와 동이 나라 ${m.levels.small}곳은 소(5), 현 ${m.levels.post}곳은 진(2)입니다. 대방·기춘처럼 191년 뒤에 군이 된 곳은 진입니다. 설명문의 첫 문장으로 가른 것이라 환현·고처럼 정체가 불확실한 곳은 진으로 두었습니다(미검증).</li>
<li><b>전장 ${m.field}곳:</b> D-054·D-055대로 진(2)입니다. 백랑산 전장·복양 성곽은 같은 자리의 거점에, 마키무쿠·구지봉·대방 왜 뱃길은 싸움터가 아니라서 야마타이국·구야국 설명에 합쳤습니다.</li>
<li><b>도시 규모 분포:</b> ${Object.entries(levelCount)
  .sort((a, b) => +a[0] - +b[0])
  .map(([k, v]) => `${{ 1: '수', 2: '진', 3: '3', 4: '이', 5: '소', 6: '중', 7: '대', 8: '특' }[k]} ${v}`)
  .join(', ')}. 최대치는 아직 규모 비례식이며 D-055의 중앙값 규칙은 구현 때 적용합니다.</li>
</ul>
<h3>도로 ${m.roads}개</h3>
<ul>
<li>현행 ${routeKinds.SAN10}개를 모두 살렸습니다. 규칙 생성 ${routeKinds['생성']}개, 직접 보강 ${routeKinds['보강']}개, 뱃길 ${routeKinds['해로']}개, 끊긴 조각을 잇는 길 ${routeKinds['연결']}개입니다.</li>
<li>새 길이 관문을 우회하는 후보 ${m.blockedGate}개와 장강·황하를 건너는 후보 ${m.blockedRiver}개는 막았습니다. 지도 전체는 하나로 이어집니다. 산맥은 아직 고려하지 못했습니다(미검증).</li>
<li>표식 겹침 ${m.fixes[0].closeBefore}쌍을 0쌍으로 풀었고 거점당 최대 12단위까지 옮겼습니다.</li>
<li><b>모드 가도:</b> 모드의 실제 가도 자료는 아직 반영하지 않았습니다. 받는 대로 규칙으로 만든 도로를 바꾸고 월경지를 다시 셉니다.</li>
</ul></section>
<section><h2>능력치</h2>
<!--BAR-->
<ul>
<li><b>모드 값 ${n(modStats)}명:</b> N24001~30의 인물 행과 확장 인물 표(시나리오별 확장 파일의 OFX1 구역, ${n(extPeople)}명)에서 통솔·무력·지력·정치·매력을 그대로 가져왔습니다. 이전 판은 확장 인물 표를 찾지 못해 2,424명을 열전으로 산정했는데, 모드에 실제 값이 있어 바꿨습니다.</li>
<li><b>열전 기준 산정 ${n(estStats)}명:</b> 모드 파일에 없는 인물입니다. 모드 인물의 열전과 능력치로 회귀식을 학습해 같은 눈금으로 산정했고, 모드 상위 10%를 넘지 않게 눌렀습니다.</li>
<li><b>산정값의 정확도:</b> 모드 인물로 5겹 교차 검증한 평균 오차는 통솔 ${statMeta.mae[0]}, 무력 ${statMeta.mae[1]}, 지력 ${statMeta.mae[2]}, 정치 ${statMeta.mae[3]}, 매력 ${statMeta.mae[4]}입니다. 전원에게 평균값을 줬을 때의 오차(${statMeta.base.join(', ')})보다 조금 나은 정도이므로 임시값으로 봐야 합니다. 인물을 누르면 어느 쪽 값인지 나옵니다.</li>
</ul></section>
<section><h2>명단 ${n(total)}명</h2>
<ul>
<li>모드의 인물 표 ${n(c.allTable)}명을 후보로 거르지 않고 모두 넣었습니다. ${n(c.tableMatched)}명은 기존 명단과 같은 사람이라 합쳤습니다.</li>
<li>이름만 같은 다른 사람 ${splitN}명은 모드 인물 번호로 갈랐습니다. 이전 판에서는 조휴의 아들 조조, 광위태수 왕윤, 무릉태수 조인 같은 사람이 이름이 같은 유명 인물과 한 사람으로 합쳐져 있었습니다. 이 때문에 동명이인 경고가 늘었습니다.</li>
<li>인물 표에 없고 이름 사전에만 있는 ${c.cand}개는 넣지 않았습니다. 대부분 글자가 잘린 조각입니다. 예: ${data.candSample.slice(0, 12).join(', ')}.</li>
</ul></section>
<section><h2>휘하 관계 ${n(check.retinueLinks)}건</h2>
<div class="scroll"><table class="dt"><thead><tr><th>근거</th><th class="num">건</th><th>뜻</th></tr></thead><tbody>
<tr><td>사서</td><td class="num">${n(sum('sa'))}</td><td>사서로 잡은 상하 관계입니다.</td></tr>
<tr><td>열전</td><td class="num">${n(sum('yj'))}</td><td>모드 열전에서 읽은 관계입니다.</td></tr>
<tr><td>추정</td><td class="num">${n(sum('ch'))}</td><td>기록을 바탕으로 제가 추정했습니다(미검증).</td></tr>
<tr><td>규칙</td><td class="num">${n(sum('rule'))}</td><td>기록이 없어 같은 도시의 태수, 그다음 군주 아래에 놓았습니다.</td></tr>
</tbody></table></div>
<p>약 ${Math.round((sum('rule') / check.retinueLinks) * 100)}%가 규칙으로 잡은 자리입니다. 휘하별 보기에서는 기록에 근거한 관계만 진한 글자로 표시합니다. 규칙 코드 <code>buildRetinueHierarchy</code>로 순환, 다중 상관, 세력 불일치, 수용량 30을 검사했고 실패는 없습니다. 최대 깊이는 ${check.maxDepth}단입니다.</p></section>
<section><h2>시나리오 ${scen.length}종</h2>
<ul>
<li><b>모드 시나리오 30종:</b> 제목, 시작 월, 인물 배치, 도시 소유를 모드 값으로 씁니다. 확장 인물의 소속과 위치도 모드 값입니다.</li>
<li><b>새로 만든 판:</b> 역사 판과 IF 판을 더했습니다. 시나리오마다 분기점이나 사서 인용, 설명을 표시합니다.</li>
<li><b>고평릉 IF 2종:</b> ${scen
  .filter((s) => s.id.startsWith('g'))
  .map((s) => `<a data-go="${s.id}">${s.title}</a>`)
  .join(', ')}. 환범의 계책이 통한 경우와 위가 갈라진 경우입니다.</li>
</ul></section>
<section><h2>한반도·왜 세력</h2>
<p>모드의 확장 세력을 그대로 씁니다. 군주와 땅은 모드 30판의 값이고, 괄호의 해는 그 군주가 처음 나오는 모드 판의 시작 해입니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>세력</th><th>군주(모드 판)</th><th>땅(가장 이른 판 → 가장 늦은 판, 모드 도시만)</th></tr></thead><tbody>
${korRows}
</tbody></table></div>
<ul>
<li>이전 판에서 손으로 세웠던 동예(불내예후)·마한(진왕)과 낙랑·대방의 군현 소유 지정은 모드에 없어 뺐습니다. 모드에서 군주 없는 땅은 공백지입니다.</li>
<li>새로 만든 판은 기준 모드 판의 땅을 그대로 두고 군주만 시작 해에 맞춥니다. 재위 연표는 모드 판의 군주에 삼국사기 재위를 맞춘 것이고 교체 연도는 추정입니다(미검증).</li>
<li>왜의 위치는 모드 설명처럼 기나이설을 따랐습니다.</li>
</ul></section>
<section><h2>정산 시간 병목</h2>
<p>현행 ${cur.sites}곳 ${cur.generals}명은 1년에 ${n(cur.msPerYear)}ms, 새 판 ${next.sites}곳 ${n(next.generals)}명은 ${n(next.msPerYear)}ms로 약 ${ratio}배입니다. 메모리에서만 잰 값이고 DB 시간은 뺐습니다. CPU 프로파일로 새 판을 쪼갠 결과입니다.</p>
<div class="scroll"><table class="dt"><thead><tr><th>구간</th><th class="num">비중</th><th>내용</th></tr></thead><tbody>
<tr><td>장수 턴 전체</td><td class="num">84%</td><td><code>runGeneralTurn</code>. 시간 대부분이 장수 수에 비례해 쓰입니다.</td></tr>
<tr><td>세계 복제</td><td class="num">52%</td><td><code>cloneWorld</code>. 명령 효과를 적용할 때마다 세계 전체를 복제합니다(<code>applyEffects</code>).</td></tr>
<tr><td>NPC 후보 계산</td><td class="num">21%</td><td><code>generalTurnCandidates</code>. 이 중 대부분이 병종 조건 계산(<code>crewContext</code> 13%)입니다.</td></tr>
<tr><td>월간 정산</td><td class="num">4%</td><td><code>runMonthly</code>. 거점이 늘어도 큰 부담이 아닙니다.</td></tr>
</tbody></table></div>
<p>거점 수보다 장수 턴마다 세계 전체를 복제하는 구조가 문제입니다. 구현에 앞서 복제를 변경분만으로 줄이는 것이 먼저입니다. 코드를 고쳐 다시 재 보지는 않았으므로 개선 폭은 미측정입니다.</p></section>
<section><h2>검증한 것</h2>
<div class="scroll"><table class="dt"><thead><tr><th>검사</th><th>결과</th></tr></thead><tbody>
<tr><td><code>validateMap</code></td><td>지도 단독 오류 ${check.mapIssues}건. 엔진이 월드를 만들 때처럼 시나리오 하나씩 넣는 검사도 ${scen.length}종 모두 통과했습니다. 구역은 아직 지도 자원 밖의 별도 자료라 이 검사 대상이 아닙니다.</td></tr>
<tr><td><code>validateScenario</code> ${check.scenarios}종</td><td>오류 ${check.withErrors}건, 동명이인 경고 ${check.warnings}건</td></tr>
<tr><td>휘하 규칙</td><td>실패 ${check.retinueFail}건, 수용량 초과 ${check.overCap}건</td></tr>
<tr><td>도시 소유</td><td>모드 30판 모두 소유 표와 인물 표가 맞습니다(어긋난 인물 ${actBad}명). 184년 판은 군주 선택 화면과 세력 구성이 같습니다.</td></tr>
<tr><td>월경지</td><td>${enclaves.length}건. 모드 가도가 아니라 임시로 만든 도로로 센 값이라 참고용입니다. 모드 값을 그대로 두었고 옮기지 않았습니다.</td></tr>
</tbody></table></div>
<p>하지 않은 것: 게임 화면과의 대조는 184년 군주 선택 화면 한 장뿐입니다. 나머지 29판은 파일끼리만 맞춰 봤습니다(미검증). 정산 시간은 이전 명단으로 잰 값이라 다시 재지 않았습니다.</p></section>
<section><h2>보류 중인 일</h2>
<ul>
<li><b>구역 세부 분할:</b> 나중에 검토합니다. 격자 자료는 준비돼 있습니다.</li>
<li><b>초상:</b> 대량 생성은 보류입니다. 시작할 때 초상 ID 범위(현재 10001~11008)도 넓혀야 합니다.</li>
<li><b>저장소 반영:</b> 커밋과 푸시는 중단한 상태입니다. 모드의 능력치와 배치는 코에이 원작에 기대고 있어 공개 저장소에 넣기 전에 권리를 봐야 합니다(AC-M3-06).</li>
</ul></section>
<section><h2>전체 목록</h2><!--TABLE--></section>
<section><h2>참고 자료</h2>
<ul>
<li>기준 자료: 로컬 폴더 「후삼국지 삼국지편」의 N24001~30, <code>hsg_event_state</code>의 시나리오별 확장 파일 30개, KOEICDA.DLL. 읽기만 했습니다.</li>
<li>지도: <code>resources/map/san10.json</code>, Natural Earth 바탕</li>
<li>장수 명단: <a href="https://github.com/opensamguk/opensamguk-images" target="_blank" rel="noopener">opensamguk-images</a></li>
<li>세력색: <a href="https://namu.wiki/w/%EC%82%BC%EA%B5%AD%EC%A7%80%20%EC%8B%9C%EB%A6%AC%EC%A6%88/%EC%83%81%EC%A7%95%EC%83%89" target="_blank" rel="noopener">나무위키 삼국지 시리즈/상징색</a>, 후삼국지 실행 파일 SAM6.EXE의 색 번호 표</li>
<li>보조 자료: <a href="https://gitea.hided.net/devsam/core2026" target="_blank" rel="noopener">core2026</a>, <a href="https://namu.wiki/w/%EC%82%BC%EA%B5%AD%EC%A7%80%20%EC%8B%9C%EB%A6%AC%EC%A6%88/%EC%8B%9C%EB%82%98%EB%A6%AC%EC%98%A4" target="_blank" rel="noopener">나무위키</a></li>
<li>사서: 三國志, 後漢書, 資治通鑑 (사료 색인 조회)</li>
${cards}
</ul></section>`;

const out = tpl
  .replace('/*DATA*/', () => JSON.stringify(data).replace(/<\//g, '<\\/'))
  .replace('/*SOURCES*/', () => JSON.stringify(SOURCES))
  .replace('/*PLAN*/', () =>
    JSON.stringify({
      html,
      coverage: [
        { label: '모드 값', n: modStats, c: 'var(--src-mod)' },
        { label: '열전 기준 산정', n: estStats, c: 'var(--src-san)' },
      ],
      total,
    }).replace(/<\//g, '<\\/'),
  );
void coverage;
const OUTPUT = process.argv[2] ?? path.join(os.tmpdir(), 'san10-scenario-plan.html');
fs.writeFileSync(OUTPUT, out);
console.log('page', OUTPUT);
console.log(
  'page MB',
  (Buffer.byteLength(out) / 1048576).toFixed(2),
  'modStats',
  modStats,
  'est',
  estStats,
  'stillBlank',
  stillBlank.join(','),
  'enclaves',
  enclaves.length,
  'avgInf',
  avgInferred,
  'claimed',
  claimedPct,
);
