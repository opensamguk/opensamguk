<title>SAN10 신규 시나리오 기획판</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* 배치: 왼쪽 연표 목록, 가운데 작전 지도, 오른쪽 세력 장부. 좁은 화면에서는 위에서 아래로 쌓는다. */
:root {
  --bg: #e9edeb; --panel: #f5f7f5; --ink: #1c2629; --muted: #5b6a6d; --line: #c8d1cf;
  --sea: #cfdde2; --land: #eef0e6; --river: #9dbfd0; --route: #a9a892; --accent: #1f5c63; --warn: #a4570f;
  --src-common: #5b6a6d; --src-merge: #7a5bb0; --src-mod: #1f7a84; --src-san: #c9822f;
  --display: 'Gowun Batang', 'Noto Serif KR', serif; --body: 'IBM Plex Sans KR', 'Noto Sans KR', system-ui, sans-serif; --mono: 'IBM Plex Mono', ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12191c; --panel: #1a2327; --ink: #e4eaea; --muted: #94a3a6; --line: #2f3c41;
  --sea: #15232b; --land: #2a3438; --river: #33566a; --route: #54584c; --accent: #7cc4cc; --warn: #e6a65c;
  --src-common: #94a3a6; --src-merge: #b398e0; --src-mod: #57c1cb; --src-san: #e6a65c; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12191c; --panel: #1a2327; --ink: #e4eaea; --muted: #94a3a6; --line: #2f3c41;
  --sea: #15232b; --land: #2a3438; --river: #33566a; --route: #54584c; --accent: #7cc4cc; --warn: #e6a65c;
  --src-common: #94a3a6; --src-merge: #b398e0; --src-mod: #57c1cb; --src-san: #e6a65c; color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--bg); color: var(--ink); font: 14px/1.55 var(--body); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 16px 40px }
h1, h2, h3 { font-family: var(--display); font-weight: 700; margin: 0; text-wrap: balance }
h1 { font-size: 22px } h2 { font-size: 24px; line-height: 1.25 } h3 { font-size: 16px }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
a { color: var(--accent) }
.top { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; margin-bottom: 14px }
.tabs { display: flex; gap: 4px } .tabs a { padding: 3px 12px; border: 1px solid var(--line); border-radius: 3px; text-decoration: none; color: var(--ink) }
.tabs a[aria-current="page"] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
.top .note { color: var(--muted); font-size: 13px }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr) 340px; gap: 14px; align-items: start }
.rail { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 8px); max-height: calc(100vh - 24px); overflow-y: auto; padding-right: 4px }
.rail h3 { font: 600 12px var(--body); letter-spacing: .06em; color: var(--muted); margin: 12px 0 4px }
.rail h3:first-child { margin-top: 0 }
.rail button { display: grid; grid-template-columns: 34px 1fr; gap: 6px; width: 100%; text-align: left; padding: 4px 6px; border-radius: 3px; line-height: 1.35 }
.rail button:hover { background: var(--panel) }
.rail button[aria-current="true"] { background: var(--accent); color: var(--bg) }
.rail .y { font: 500 12px var(--mono); opacity: .8; padding-top: 1px }
.rail .new { font: 600 10px var(--body); color: var(--warn); margin-left: 4px }
.rail button[aria-current="true"] .new { color: inherit }
.rail select { display: none; width: 100%; font: inherit; padding: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 3px }
.head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 18px; margin-bottom: 8px }
.head .when { font: 500 12px var(--mono); color: var(--muted); letter-spacing: .03em }
.premise { margin: 6px 0 0; max-width: 62ch }
.src { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); max-width: 70ch }
.src q { font-family: var(--display); color: var(--ink); quotes: none }
.tag { display: inline-block; font: 500 11px var(--body); padding: 1px 6px; border-radius: 2px; border: 1px solid currentColor; color: var(--accent); margin-right: 4px }
.tag.if { color: var(--warn) }
.stats { display: grid; grid-template-columns: repeat(4, auto); gap: 0 18px; align-self: start; font-variant-numeric: tabular-nums }
.stats b { display: block; font: 700 20px var(--display) } .stats span { font-size: 11.5px; color: var(--muted) }
.zoom { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; align-items: center }
.zoom button { font-size: 12.5px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 3px; background: var(--panel) }
.zoom button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
.zoom .sep { flex: 1 1 8px }
.mapbox { background: var(--sea); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; position: relative }
.mapbox svg { display: block; width: 100%; height: auto; touch-action: manipulation }
.land { fill: var(--land); stroke: var(--line); stroke-width: .6 } .lake { fill: var(--sea) } .riv { fill: none; stroke: var(--river); stroke-width: 1 }
.road { stroke: var(--route); stroke-width: .9 } .road.owned { stroke-width: 1.6 } .road.gen { stroke-dasharray: 3 3 }
.site { cursor: pointer } .site text { font-family: var(--body); font-weight: 500; fill: var(--ink); paint-order: stroke; stroke: var(--land); stroke-width: 2.5px; pointer-events: none }
.site.sel circle, .site.sel rect { stroke: var(--ink); stroke-width: 3 }
.dim .site.fade, .dim .road.fade { opacity: .22 }
.legend { display: flex; flex-wrap: wrap; gap: 3px 12px; margin: 8px 0; font-size: 12px; color: var(--muted) }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 10px 12px; min-width: 0 }
.panel + .panel { margin-top: 12px }
.ftable { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums }
.ftable th { font: 500 11px var(--body); color: var(--muted); text-align: right; padding: 0 0 3px 6px } .ftable th:first-child { text-align: left; padding-left: 0 }
.ftable td { padding: 3px 0 3px 6px; text-align: right; border-top: 1px solid var(--line) } .ftable td:first-child { text-align: left; padding-left: 0 }
.ftable tr { cursor: pointer } .ftable tbody tr:hover td { background: var(--bg) }
.ftable tr.on td { background: var(--bg); font-weight: 600 }
.ftwrap { max-height: 300px; overflow-y: auto }
.sw { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 2px; vertical-align: 0 }
.rows { max-height: 520px; overflow-y: auto; margin-top: 8px }
.ctl { display: flex; gap: 8px; align-items: center; flex-wrap: wrap }
.ctl input { flex: 1 1 120px; min-width: 0; font: inherit; padding: 4px 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 3px }
.ctl button { font-size: 12px; color: var(--accent); text-decoration: underline }
.city { margin-top: 8px } .city h4 { margin: 0 0 2px; font: 600 12.5px var(--body) } .city h4 span { color: var(--muted); font-weight: 400 }
.fgroup { margin-top: 12px } .fgroup > h3 { font-size: 15px; border-bottom: 1px solid var(--line); padding-bottom: 2px }
.names { display: flex; flex-wrap: wrap; gap: 1px 8px; font-size: 13px }
.r0 { font-weight: 700; color: var(--accent) } .r1 { font-weight: 600 } .n-추정, .n-후기표 { text-decoration: underline dotted; text-underline-offset: 3px } .n-auto { color: var(--muted) } .t2::after { content: '＋'; font-size: 10px; color: var(--warn) }
.desc { margin: 6px 0 0; max-width: 72ch; font-size: 13px; color: var(--muted) }
.vtog { display: flex; gap: 4px; margin-top: 8px } .vtog button { font-size: 12.5px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 3px } .vtog button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
.names span[data-id], .tree span[data-id] { cursor: pointer } .names span[data-id]:hover, .tree span[data-id]:hover { color: var(--accent); text-decoration: underline }
.tree { list-style: none; margin: 0; padding: 0 0 0 12px; border-left: 1px solid var(--line); font-size: 13px } .tree > li { padding: 1px 0 } .tree .rel { font-size: 10.5px; color: var(--muted); margin-right: 3px } .tree .rec { color: var(--accent); font-weight: 600 }
.person { font-size: 12.5px; border: 1px solid var(--line); border-radius: 3px; padding: 8px 10px; margin: 8px 0 0; background: var(--bg) } .person b { font-size: 14px; font-family: var(--display) } .person p { margin: 4px 0 0 }
.field text { font-family: var(--body); fill: var(--muted); paint-order: stroke; stroke: var(--land); stroke-width: 2.5px } .field path { stroke: var(--warn); stroke-width: 1.2; fill: none } .field { cursor: help }
.samples img { width: 100%; max-width: 720px; height: auto; display: block; border-radius: 3px; margin: 8px 0 }
.cityinfo { font-size: 12.5px; border-left: 3px solid var(--accent); padding: 2px 0 2px 10px; margin: 8px 0 0 } .cityinfo b { font-size: 13.5px }
.issues { margin: 6px 0 0; padding: 0; list-style: none; font-size: 12.5px } .issues li { padding: 2px 0 } .issues b { color: var(--warn); font-weight: 600 }
.ok { color: var(--muted); font-size: 12.5px; margin: 4px 0 0 }
.doc { max-width: 880px } .doc section { margin-bottom: 26px } .doc h2 { margin-bottom: 8px } .doc h3 { margin: 12px 0 4px } .doc p { margin: 6px 0; max-width: 68ch } .doc ul, .doc ol { margin: 6px 0; padding-left: 20px; max-width: 72ch } .doc li { margin: 3px 0 }
.scroll { overflow-x: auto } .dt { border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; min-width: 520px; width: 100% } .dt th { text-align: left; font: 500 11.5px var(--body); color: var(--muted); padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line) } .dt td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top }
.dt .num { text-align: right } .dt a { cursor: pointer }
.q { border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; margin: 10px 0 } .q b { display: block } .rec { color: var(--accent); font-weight: 600 }
.bar { display: flex; height: 10px; border-radius: 2px; overflow: hidden; margin: 6px 0 4px; max-width: 620px } .bar i { display: block } .barkey { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 12.5px; color: var(--muted) } .barkey i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 2px }
.chips { font-size: 12.5px; color: var(--muted); max-width: 72ch }
@media (max-width: 1180px) { .layout { grid-template-columns: 200px minmax(0, 1fr) } .side { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start } .side .panel + .panel { margin-top: 0 } }
@media (max-width: 760px) { .layout { grid-template-columns: minmax(0, 1fr) } .rail { position: static; max-height: none; overflow: visible } .rail .list { display: none } .rail select { display: block } .side { display: block } .side .panel + .panel { margin-top: 12px } .stats { grid-template-columns: repeat(4, 1fr); width: 100% } h2 { font-size: 21px } .rows { max-height: none } .ftwrap { max-height: none } }
</style>
<div class="top">
  <h1>SAN10 신규 시나리오 기획판</h1>
  <nav class="tabs"><a href="#scenarios" id="tab-s">시나리오</a><a href="#plan" id="tab-p">계획·결정</a></nav>
  <span class="note">검토용 초안입니다. 게임 데이터는 바꾸지 않았습니다.</span>
</div>
<div id="view-s" class="layout">
  <aside class="rail"><select id="sc-select" aria-label="시나리오 선택"></select><div class="list" id="rail"></div></aside>
  <main style="min-width:0">
    <div class="head"><div style="min-width:0;flex:1 1 320px"><div class="when" id="sc-when"></div><h2 id="sc-title"></h2><p class="premise" id="sc-premise"></p><p class="src" id="sc-src"></p><p class="desc" id="sc-desc"></p></div><div class="stats" id="sc-stats"></div></div>
    <div class="zoom" id="zoom"></div>
    <div class="mapbox"><svg id="map" viewBox="0 0 1400 1000" role="img" aria-label="새 지도 위의 세력 배치"></svg></div>
    <div class="legend" id="legend"></div>
  </main>
  <div class="side">
    <div class="panel"><h3>세력 배치</h3><div class="scroll ftwrap"><table class="ftable"><thead><tr><th>세력(군주)</th><th>수도</th><th>거점</th><th>인물</th></tr></thead><tbody id="ftable"></tbody></table></div><h3 style="margin-top:12px">초안 검사</h3><div id="issues"></div></div>
    <div class="panel"><h3>인물 배치</h3><div class="ctl" style="margin-top:6px"><input id="q" type="search" placeholder="이름·한자 찾기" aria-label="인물 검색"><button id="clear" type="button">전체 보기</button></div>
      <div class="legend" style="margin-bottom:0"><span class="r0">군주</span><span class="r1">태수·지정</span><span>일반</span><span class="n-추정">추정</span><span class="n-auto">회색 = 도시 자동</span><span class="t2">새 인물</span></div>
      <div class="vtog" role="group" aria-label="보기"><button id="v-city" type="button" aria-pressed="true">도시별</button><button id="v-tree" type="button" aria-pressed="false">휘하별</button></div><div id="person"></div><div id="cityinfo"></div><div class="rows" id="rows"></div></div>
  </div>
</div>
<div id="view-p" class="doc" hidden></div>
<script id="data" type="application/json">/*DATA*/</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const SRC = /*SOURCES*/;
const PLAN = /*PLAN*/;
const $ = (id) => document.getElementById(id);
const ro = new Map(D.roster.map((r) => [r[0], r]));
const siteAt = new Map(D.sites.map((s) => [s[0], s]));
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}, parent) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let cur = D.scenarios[0], fsel = null, csel = null, nodes = new Map(), roads = [], mode = 'faction', vb = null, fieldNodes = [], view = 'city', psel = null;
const main = D.sites.filter((s) => s[5] !== 15);
const bounds = (list, pad = 26) => { const xs = list.map((s) => s[1]), ys = list.map((s) => s[2]); return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2 + 30, Math.max(...ys) - Math.min(...ys) + pad * 2]; };
const VIEWS = [['본토', bounds(main)], ['전체', [0, 0, 1400, 1000]], ['중원', [470, 400, 340, 250]], ['강남', [540, 590, 330, 250]], ['서촉·남중', [220, 520, 340, 280]], ['하북·요동', [560, 230, 360, 240]], ['삼한·왜', [800, 280, 500, 340]]];
function baseMap() {
  const svg = $('map');
  for (const d of D.land) el('path', { d, class: 'land' }, svg);
  for (const d of D.lakes ?? []) el('path', { d, class: 'lake' }, svg);
  for (const d of D.rivers ?? []) el('path', { d, class: 'riv' }, svg);
  const rg = el('g', {}, svg);
  for (const [a, b, kind] of D.routes) { const p = siteAt.get(a), q = siteAt.get(b); if (p && q) roads.push({ a, b, e: el('line', { x1: p[1], y1: p[2], x2: q[1], y2: q[2], class: `road${kind === 'SAN10' ? '' : ' gen'}` }, rg) }); }
  const fg = el('g', {}, svg);
  fieldNodes = (D.fields ?? []).map(([n, x, y, dsc]) => { const g = el('g', { class: 'field', transform: `translate(${x},${y})` }, fg); el('path', { d: 'M-3 -3L3 3M-3 3L3 -3' }, g); const tx = el('text', { x: 4, y: 3 }, g); tx.textContent = n; el('title', {}, g).textContent = `${n}: ${dsc}`; return { g, tx }; });
  const sg = el('g', {}, svg);
  for (const s of D.sites) {
    const g = el('g', { class: 'site', transform: `translate(${s[1]},${s[2]})`, tabindex: 0, role: 'button', 'aria-label': s[0] }, sg);
    const r = 2.4 + Math.min(s[4] || 2, 8) * 0.42;
    const shape = s[3] === 'P' ? el('rect', { x: -3.5, y: -3.5, width: 7, height: 7 }, g) : el('circle', { r }, g);
    const t = el('text', { x: r + 2, y: 3 }, g); t.textContent = s[0];
    nodes.set(s[0], { g, shape, t, big: (s[4] || 0) >= 6, r, src: s[6] });
    const pick = () => { csel = csel === s[0] ? null : s[0]; fsel = null; paint(); };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    el('title', {}, g).textContent = s[0];
  }
}
function setView(i) {
  vb = VIEWS[i][1];
  $('map').setAttribute('viewBox', vb.join(' '));
  document.querySelectorAll('#zoom button[data-v]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.v === i));
  paint();
}
function buildZoom() {
  const z = $('zoom');
  VIEWS.forEach(([n], i) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = i; b.textContent = n; b.addEventListener('click', () => setView(i)); z.appendChild(b); });
  const sp = document.createElement('span'); sp.className = 'sep'; z.appendChild(sp);
  const m = document.createElement('button'); m.type = 'button'; m.id = 'modeBtn'; m.textContent = '거점 출처 보기'; m.setAttribute('aria-pressed', 'false');
  m.addEventListener('click', () => { mode = mode === 'faction' ? 'source' : 'faction'; m.setAttribute('aria-pressed', mode === 'source'); paint(); });
  z.appendChild(m);
}
function buildRail() {
  const groups = [['역사', '역사 시나리오'], ['IF', 'IF 시나리오']];
  const rail = $('rail'), sel = $('sc-select');
  for (const [t, label] of groups) {
    const list = D.scenarios.filter((s) => s.type === t);
    const h = document.createElement('h3'); h.textContent = `${label} ${list.length}`; rail.appendChild(h);
    const og = document.createElement('optgroup'); og.label = label; sel.appendChild(og);
    for (const s of list) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.id = s.id;
      b.innerHTML = `<span class="y">${s.year}</span><span>${esc(s.title)}${s.id.startsWith('g') ? '<span class="new">신규</span>' : ''}</span>`;
      b.addEventListener('click', () => show(s.id)); rail.appendChild(b);
      const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.year} ${s.title}`; og.appendChild(o);
    }
  }
  sel.addEventListener('change', () => show(sel.value));
}
function show(id) {
  cur = D.scenarios.find((s) => s.id === id) ?? D.scenarios[0]; fsel = null; csel = null; $('q').value = '';
  document.querySelectorAll('#rail button').forEach((b) => b.setAttribute('aria-current', b.dataset.id === cur.id));
  $('sc-select').value = cur.id;
  $('sc-when').innerHTML = `<span class="tag ${cur.type === 'IF' ? 'if' : ''}">${cur.type}</span>${cur.short ? '<span class="tag">짧은 판</span>' : ''}${cur.year}년 ${cur.month}월 시작`;
  $('sc-title').textContent = cur.title;
  $('sc-premise').textContent = cur.premise ?? '';
  $('sc-desc').textContent = cur.desc ?? '';
  psel = null; $('person').innerHTML = '';
  const q = cur.source ?? SRC[cur.id];
  $('sc-src').innerHTML = (cur.divergence ? `분기점: ${esc(cur.divergence)}. ` : '') + (q ? `<q>${esc(q[1])}</q> (${esc(q[0])}) ` : '') + (cur.short ? `원작 짧은 판: ${esc(cur.short[0])}, ${esc(cur.short[1])}. ` : '') + (cur.file ? `원본: N240${String(cur.file).padStart(2, '0')}` : '기준 세력도: N24022');
  const free = cur.officers.filter((o) => o[1] < 0).length;
  $('sc-stats').innerHTML = [[cur.factions.length, '세력'], [`${cur.owned}/${cur.total}`, '점령 거점'], [cur.alive - free, '소속 인물'], [free, '재야']].map(([a, b]) => `<div><b>${a}</b><span>${b}</span></div>`).join('');
  const tb = $('ftable'); tb.innerHTML = '';
  cur.factions.forEach((f, i) => {
    const tr = document.createElement('tr'); tr.dataset.i = i; tr.tabIndex = 0;
    tr.innerHTML = `<td><span class="sw" style="background:${f.color}"></span>${esc(f.name)}</td><td>${esc(f.capital)}</td><td>${f.cities.length}</td><td>${f.count}</td>`;
    const act = () => { fsel = fsel === i ? null : i; csel = null; paint(); };
    tr.addEventListener('click', act); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(); });
    tb.appendChild(tr);
  });
  const g = {}; for (const it of cur.issues) (g[it.k] ??= []).push(it.v);
  const keys = Object.keys(g);
  $('issues').innerHTML = (keys.length ? `<ul class="issues">${keys.map((k) => `<li><b>${esc(k)}</b> ${esc(g[k].join(', '))}</li>`).join('')}</ul>` : '<p class="ok">월경지와 관문 수도가 없습니다.</p>') + `<p class="ok">거점 ${cur.owned}곳 중 ${cur.inferred.length}곳은 도로 이웃에서 소유를 추정했습니다(점선 테두리).</p>`;
  paint();
}
function paint() {
  const owner = cur.owner, inf = new Set(cur.inferred);
  const capitals = new Set(cur.factions.map((f) => f.capital));
  const svg = $('map'); svg.classList.toggle('dim', fsel !== null && mode === 'faction');
  const w = vb ? vb[2] : 1400;
  const size = Math.max(7, w / 62);
  const zoomed = w < 700;
  const SRCCOL = { 공통: 'var(--src-common)', 통합: 'var(--src-merge)', 모드: 'var(--src-mod)', SAN10: 'var(--src-san)' };
  for (const [name, n] of nodes) {
    const oi = owner[name];
    const f = oi === undefined ? null : cur.factions[oi];
    if (mode === 'faction') {
      n.shape.setAttribute('fill', f ? f.color : 'var(--panel)');
      n.shape.setAttribute('stroke', f ? 'var(--ink)' : 'var(--muted)');
      n.shape.setAttribute('stroke-dasharray', inf.has(name) ? '1.6 1.2' : '');
    } else {
      n.shape.setAttribute('fill', SRCCOL[n.src]); n.shape.setAttribute('stroke', 'var(--ink)'); n.shape.setAttribute('stroke-dasharray', '');
    }
    n.shape.setAttribute('stroke-width', mode === 'faction' && capitals.has(name) ? 1.8 : 0.6);
    if (n.shape.tagName === 'circle') n.shape.setAttribute('r', mode === 'faction' && capitals.has(name) ? n.r + 2.4 : n.r);
    n.t.style.fontSize = `${size}px`;
    n.t.style.display = zoomed || n.big || capitals.has(name) || csel === name ? '' : 'none';
    n.g.classList.toggle('sel', csel === name);
    n.g.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel);
  }
  for (const r of roads) {
    const a = owner[r.a], b = owner[r.b];
    const same = mode === 'faction' && a !== undefined && a === b;
    r.e.classList.toggle('owned', same);
    r.e.style.stroke = same ? cur.factions[a].color : '';
    r.e.classList.toggle('fade', mode === 'faction' && fsel !== null && !(same && a === fsel));
  }
  for (const f of fieldNodes) { f.tx.style.fontSize = `${Math.max(6, w / 75)}px`; f.tx.style.display = zoomed ? '' : 'none'; }
  $('legend').innerHTML = mode === 'faction' ? '<span>● 도시 · ■ 관문</span><span>큰 원 = 수도</span><span>빈 표식 = 공백지</span><span>점선 테두리 = 소유 추정</span><span>점선 길 = 새로 만든 도로</span><span>× = 전장</span>' : `<span><i class="key" style="background:var(--src-common)"></i>두 지도 공통 ${D.map.common}</span><span><i class="key" style="background:var(--src-merge)"></i>같은 곳·표기 통합 ${D.map.merged}</span><span><i class="key" style="background:var(--src-mod)"></i>모드에서 추가 ${D.map.mod}</span><span><i class="key" style="background:var(--src-san)"></i>SAN10에서 유지 ${D.map.san}</span>`;
  document.querySelectorAll('#ftable tr').forEach((tr) => tr.classList.toggle('on', +tr.dataset.i === fsel));
  const ci = $('cityinfo');
  if (csel) { const s = siteAt.get(csel); const srcName = { 공통: '두 지도 공통', 통합: '같은 곳을 통합', 모드: '모드에서 추가', SAN10: 'SAN10에서 유지' }[s[6]]; const oi = owner[csel]; ci.innerHTML = `<div class="cityinfo"><b>${esc(csel)}</b> · ${oi === undefined ? '공백지' : esc(cur.factions[oi].name)} · ${srcName}${s[7] ? ` (SAN10 ${esc(s[7])})` : ''}${s[9] ? ` · ${esc(s[9])}` : ''}${s[8] ? `<br>${esc(s[8])}` : ''}</div>`; } else ci.innerHTML = '';
  rows();
}
function personBox(id) {
  const r = ro.get(id); if (!r) return;
  const o = cur.officers.find((x) => x[0] === id);
  const f = o && o[1] >= 0 ? cur.factions[o[1]] : null;
  const m = o && o[6] ? ro.get(o[6]) : null;
  const kids = cur.officers.filter((x) => x[6] === id).map((x) => ro.get(x[0])[1]);
  const REL = { S: '가신', L: '부장', G: '식객' };
  $('person').innerHTML = `<div class="person"><b>${esc(r[1])}</b> ${esc(r[2])} · ${r[3] ?? '?'}~${r[4] ?? '?'} · ${f ? esc(f.name) : '재야'}${o && o[2] ? ' · ' + esc(o[2]) : ''}<p>${m ? `상관: ${esc(m[1])} (${REL[o[7]] ?? ''}, ${esc(o[8])})` : f && f.ruler === id ? '군주' : '상관 없음'}${kids.length ? ` · 직속 ${kids.length}명: ${esc(kids.slice(0, 12).join(', '))}${kids.length > 12 ? ' 외' : ''}` : ''}</p><p>${esc(r[7] || '설명 없음')}</p><p style="color:var(--muted)">연대 출처: ${esc(r[5])} · 배치: ${o ? esc(o[3]) : ''}</p></div>`;
}
function treeHtml(list, f, i) {
  const kids = new Map();
  for (const o of list) { if (!kids.has(o[6])) kids.set(o[6], []); kids.get(o[6]).push(o); }
  const REL = { S: '가', L: '부', G: '식' };
  const nodeHtml = (o, depth) => { const r = ro.get(o[0]); const ch = kids.get(o[0]) ?? []; const rec = o[8] && o[8] !== '규칙'; return `<li><span class="rel${rec ? ' rec' : ''}">${REL[o[7]] ?? ''}</span><span data-id="${o[0]}" tabindex="0" role="button" class="${o[5] === 0 ? 'r0' : o[5] === 1 ? 'r1' : ''}${r[6] >= 2 ? ' t2' : ''}">${esc(r[1])}</span>${depth < 12 && ch.length ? `<ul class="tree">${ch.sort((a, b) => a[5] - b[5]).map((c) => nodeHtml(c, depth + 1)).join('')}</ul>` : ''}</li>`; };
  const root = list.filter((o) => o[0] === f.ruler);
  const orphan = list.filter((o) => !o[6] && o[0] !== f.ruler);
  return `<ul class="tree" style="border:0;padding:0">${[...root, ...orphan].map((o) => nodeHtml(o, 0)).join('')}</ul>`;
}
function rows() {
  if (view === 'tree') {
    const q = $('q').value.trim();
    let html = '<p class="ok">가 = 가신, 부 = 부장, 식 = 식객. 진한 글자는 사서·열전에 기록된 관계이고 나머지는 규칙으로 잡은 자리입니다.</p>';
    cur.factions.forEach((f, i) => {
      if (fsel !== null && fsel !== i) return;
      let list = cur.officers.filter((o) => o[1] === i);
      if (q && !list.some((o) => ro.get(o[0])[1].includes(q))) return;
      const rec = list.filter((o) => o[8] && o[8] !== '규칙').length;
      html += `<div class="fgroup"><h3><span class="sw" style="background:${f.color}"></span>${esc(f.name)} <small style="font:400 12px var(--body);color:var(--muted)">${list.length}명 · 기록 관계 ${rec}</small></h3>${treeHtml(list, f, i)}</div>`;
    });
    $('rows').innerHTML = html;
    return;
  }
  const q = $('q').value.trim();
  let list = cur.officers;
  if (fsel !== null) list = list.filter((o) => o[1] === fsel);
  if (csel) list = list.filter((o) => o[2] === csel);
  if (q) list = list.filter((o) => { const r = ro.get(o[0]); return r[1].includes(q) || (r[2] || '').includes(q); });
  const byF = new Map();
  for (const o of list) { const k = o[1]; if (!byF.has(k)) byF.set(k, new Map()); const m = byF.get(k); const c = o[2] || '소재 미정'; if (!m.has(c)) m.set(c, []); m.get(c).push(o); }
  const order = [...byF.keys()].sort((a, b) => (a < 0 ? 1e3 : a) - (b < 0 ? 1e3 : b));
  let html = csel ? `<p class="ok">이 거점의 인물 ${list.length}명</p>` : '';
  for (const k of order) {
    const f = cur.factions[k];
    const total = [...byF.get(k).values()].reduce((n, v) => n + v.length, 0);
    html += `<div class="fgroup"><h3>${f ? `<span class="sw" style="background:${f.color}"></span>${esc(f.name)}` : '재야'} <small style="font:400 12px var(--body);color:var(--muted)">${total}명</small></h3>`;
    const cities = [...byF.get(k).entries()].sort((a, b) => (f && a[0] === f.capital ? -1 : f && b[0] === f.capital ? 1 : 0) || b[1].length - a[1].length);
    for (const [c, os] of cities) {
      os.sort((a, b) => a[5] - b[5]);
      html += `<div class="city"><h4>${esc(c)} <span>${os.length}</span></h4><div class="names">${os.map((o) => { const r = ro.get(o[0]); const cls = [`n-${o[3]}`, o[4] ? 'n-auto' : '', o[5] === 0 ? 'r0' : o[5] === 1 || o[3] === '지정' ? 'r1' : '', r[6] === 2 ? 't2' : ''].join(' '); return `<span data-id="${o[0]}" tabindex="0" role="button" class="${esc(cls)}" title="${esc(r[2])} ${r[3] ?? '?'}~${r[4] ?? '?'} · 연대 ${esc(r[5])} · 배치 ${esc(o[3])}${r[7] ? ' · ' + esc(r[7]) : ''}">${esc(r[1])}</span>`; }).join('')}</div></div>`;
    }
    html += '</div>';
  }
  $('rows').innerHTML = html || '<p class="ok">조건에 맞는 인물이 없습니다.</p>';
}
function planView() {
  const seg = PLAN.coverage.map((s) => `<i style="width:${(s.n / PLAN.total) * 100}%;background:${s.c}"></i>`).join('');
  const key = PLAN.coverage.map((s) => `<span><i style="background:${s.c}"></i>${esc(s.label)} ${s.n}명</span>`).join('');
  const table = D.scenarios.map((s) => { const free = s.officers.filter((o) => o[1] < 0).length; return `<tr><td><a data-go="${s.id}">${esc(s.title)}</a></td><td class="num">${s.year}.${s.month}</td><td>${s.type}${s.short ? '·짧은 판' : ''}</td><td class="num">${s.factions.length}</td><td class="num">${s.owned}</td><td class="num">${s.alive - free}</td><td class="num">${free}</td><td>${s.issues.length ? esc([...new Set(s.issues.map((i) => i.k))].join(', ')) : '없음'}</td></tr>`; }).join('');
  $('view-p').innerHTML = PLAN.html.replace('<!--BAR-->', `<div class="bar" role="img" aria-label="명단 자료 출처 구성">${seg}</div><div class="barkey">${key}</div>`).replace('<!--TABLE-->', `<div class="scroll"><table class="dt"><thead><tr><th>시나리오</th><th class="num">시작</th><th>종류</th><th class="num">세력</th><th class="num">거점</th><th class="num">소속</th><th class="num">재야</th><th>검사 표시</th></tr></thead><tbody>${table}</tbody></table></div>`);
  $('view-p').querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', () => { location.hash = '#scenarios'; route(); show(a.dataset.go); }));
}
function route() {
  const plan = location.hash === '#plan';
  $('view-s').hidden = plan; $('view-p').hidden = !plan;
  $('tab-s').removeAttribute('aria-current'); $('tab-p').removeAttribute('aria-current');
  (plan ? $('tab-p') : $('tab-s')).setAttribute('aria-current', 'page');
}
$('rows').addEventListener('click', (e) => { const s = e.target.closest('[data-id]'); if (s) personBox(+s.dataset.id); });
$('rows').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const s = e.target.closest('[data-id]'); if (s) personBox(+s.dataset.id); });
const setV = (v) => { view = v; $('v-city').setAttribute('aria-pressed', v === 'city'); $('v-tree').setAttribute('aria-pressed', v === 'tree'); rows(); };
$('v-city').addEventListener('click', () => setV('city')); $('v-tree').addEventListener('click', () => setV('tree'));
$('q').addEventListener('input', rows);
$('clear').addEventListener('click', () => { fsel = null; csel = null; $('q').value = ''; paint(); });
window.addEventListener('hashchange', route);
baseMap(); buildZoom(); buildRail(); planView();
vb = VIEWS[0][1];
show('n04');
setView(1);
route();
</script>
