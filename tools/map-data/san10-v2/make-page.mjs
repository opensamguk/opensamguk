// 최신 data2.json과 구역·검증 결과로 기획 페이지를 만든다.
import fs from 'node:fs';
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
const { sources: SOURCES, korea, cards } = load(`${S}/data/page-fragments.json`);

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
  "${oi === undefined ? '공백지' : esc(cur.factions[oi].name)}${cur.inferred.includes(csel) ? '(소유 추정)' : ''} · 규모 ${LEVEL[s[4]] ?? s[4]} · 구역 ${zoneArea.get(csel) ?? 0}칸 · ${srcName}",
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
  '거점 ${cur.owned}곳 중 ${cur.inferred.length}곳은 인물이 없어 소유를 추정했습니다(점선 테두리).',
);
rep(
  '검토용 초안입니다. 게임 데이터는 바꾸지 않았습니다.',
  '검토용 초안입니다. 저장소의 게임 데이터는 바꾸지 않았습니다.',
);

const m = data.map,
  c = data.coverage,
  scen = data.scenarios;
const hist = scen.filter((s) => s.type === '역사').length,
  ifs = scen.filter((s) => s.type === 'IF').length;
const n = (v) => v.toLocaleString('ko-KR');
const sum = (k) => scen.reduce((t, s) => t + s.linkStat[k], 0);
const total = data.roster.length;
const modStats = data.roster.filter((r) => r[9] === '모드').length;
const estStats = data.roster.filter((r) => r[9] === '추정').length;
const enclaves = scen.flatMap((s) => s.issues.filter((i) => i.k === '월경지').map((i) => i.v));
const enclaveKinds = [...new Set(enclaves)];
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
<section><h2>공백지</h2>
<p>모드 파일에 도시 소유 표가 없어 인물이 있는 도시로 소유를 계산합니다. 이전 판은 인물이 없는 거점을 비워 두어, 224년에 업·계·하내까지 공백지였습니다. 이제 아래 순서로 채웁니다.</p>
<ol>
<li><b>연대별 주 지배 표:</b> 189년까지는 후한, 207년부터 사례·예·기·연·서·청·병주와 유주는 조씨(요동은 238년까지 공손씨), 214년부터 량주는 조씨, 215~262년 익주는 촉, 교주는 사섭(226년부터 오)입니다.</li>
<li><b>주의 대세:</b> 큰 세력이 그 주 거점의 70% 이상을 가지면 나머지도 따라갑니다.</li>
<li><b>가까운 세력:</b> 남은 곳은 도로로 가장 가까운 세력을 따릅니다. 황건과 이민족은 이 단계에서 넓어지지 않고, 끊긴 조각을 정리한 뒤에도 남는 거점만 이웃이 가집니다.</li>
</ol>
<p>결과: 본토 ${mainland.length}곳의 공백지가 ${stillBlank.length ? `${stillBlank.join(', ')}을 뺀 모든 판에서 0입니다. 영웅 집결은 일부러 빈 땅에서 시작하는 판이라 그대로 둡니다.` : '모든 판에서 0입니다.'} 이민족·동이 땅과 낙랑·대방은 이 규칙에서 뺐으므로 비어 있을 수 있습니다. 이렇게 채운 거점은 판마다 평균 ${avgInferred}곳이고 표식 점선과 설명의 「소유 추정」으로 구분합니다. 사서와 맞춘 것은 주 단위까지이며 거점별 소유는 미검증입니다.</p></section>
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
</ul></section>
<section><h2>능력치</h2>
<!--BAR-->
<ul>
<li><b>모드 값 ${n(modStats)}명:</b> N24001~30의 인물 행에서 통솔·무력·지력·정치·매력을 그대로 가져왔습니다. 동명이인은 생년으로 가렸습니다.</li>
<li><b>열전 기준 산정 ${n(estStats)}명:</b> 모드 파일에 능력치 칸이 없는 인물입니다. 모드 인물의 열전과 능력치로 회귀식을 학습해 같은 눈금으로 산정했고, 모드 상위 10%를 넘지 않게 눌렀습니다.</li>
<li><b>산정값의 정확도:</b> 모드 인물로 5겹 교차 검증한 평균 오차는 통솔 ${statMeta.mae[0]}, 무력 ${statMeta.mae[1]}, 지력 ${statMeta.mae[2]}, 정치 ${statMeta.mae[3]}, 매력 ${statMeta.mae[4]}입니다. 전원에게 평균값을 줬을 때의 오차(${statMeta.base.join(', ')})보다 조금 나은 정도이므로 임시값으로 봐야 합니다. 인물을 누르면 어느 쪽 값인지 나옵니다.</li>
</ul></section>
<section><h2>명단 ${n(total)}명</h2>
<ul>
<li>모드의 인물 표 ${n(c.allTable)}명을 후보로 거르지 않고 모두 넣었습니다. ${n(c.tableMatched)}명은 기존 명단과 같은 사람이라 합쳤습니다.</li>
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
<li><b>모드 시나리오 30종:</b> 제목, 시작 월, 인물 배치를 모드 값으로 씁니다.</li>
<li><b>새로 만든 판:</b> 역사 판과 IF 판을 더했습니다. 시나리오마다 분기점이나 사서 인용, 설명을 표시합니다.</li>
<li><b>고평릉 IF 2종:</b> ${scen
  .filter((s) => s.id.startsWith('g'))
  .map((s) => `<a data-go="${s.id}">${s.title}</a>`)
  .join(', ')}. 환범의 계책이 통한 경우와 위가 갈라진 경우입니다.</li>
</ul></section>
${korea}
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
<tr><td>월경지</td><td>${enclaves.length}건. 모두 낙랑·대방·기리영 군현입니다(${enclaveKinds.join(', ')}).</td></tr>
</tbody></table></div>
<p>하지 않은 것: 인물 배치 전수 대조와 게임을 실행해 모드와 맞춰 보는 일은 하지 않았습니다(미검증).</p></section>
<section><h2>보류 중인 일</h2>
<ul>
<li><b>구역 세부 분할:</b> 나중에 검토합니다. 격자 자료는 준비돼 있습니다.</li>
<li><b>초상:</b> 대량 생성은 보류입니다. 시작할 때 초상 ID 범위(현재 10001~11008)도 넓혀야 합니다.</li>
<li><b>저장소 반영:</b> 커밋과 푸시는 중단한 상태입니다. 모드의 능력치와 배치는 코에이 원작에 기대고 있어 공개 저장소에 넣기 전에 권리를 봐야 합니다(AC-M3-06).</li>
</ul></section>
<section><h2>전체 목록</h2><!--TABLE--></section>
<section><h2>참고 자료</h2>
<ul>
<li>기준 자료: 로컬 폴더 「후삼국지 삼국지편」의 N24001~30과 KOEICDA.DLL. 읽기만 했습니다.</li>
<li>지도: <code>resources/map/san10.json</code>, Natural Earth 바탕</li>
<li>장수 명단: <a href="https://github.com/opensamguk/opensamguk-images" target="_blank" rel="noopener">opensamguk-images</a></li>
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
