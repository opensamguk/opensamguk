// 시나리오 화면의 외교 표시. make-page.mjs가 템플릿을 다 고친 뒤에 부른다.
const must = (tpl, a) => {
  if (!tpl.includes(a)) throw new Error('diplo-ui: ' + a.slice(0, 60));
};

const PANEL = `  { const dp = cur.diplomacy ?? []; const deg = new Map(); for (const [a, c] of dp) { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(c, (deg.get(c) ?? 0) + 1); }
    const tag = (s) => (s === '모드' ? '' : \` <span class="dsrc">\${esc(s)}</span>\`);
    const grp = (kind) => { const by = new Map(); for (const [a, c, k, s] of dp) { if (k !== kind) continue; const hub = (deg.get(a) ?? 0) > (deg.get(c) ?? 0) || ((deg.get(a) ?? 0) === (deg.get(c) ?? 0) && a < c) ? a : c; const other = hub === a ? c : a; if (!by.has(hub)) by.set(hub, []); by.get(hub).push([other, s]); } return [...by.entries()].sort((p, q) => q[1].length - p[1].length || p[0] - q[0]); };
    const ul = (rows) => (rows.length ? \`<ul class="issues">\${rows.map(([x, ys]) => \`<li><span class="sw" style="background:\${cur.factions[x].color}"></span>\${esc(cur.factions[x].name)} — \${ys.map(([y, s]) => esc(cur.factions[y].name) + tag(s)).join(', ')}</li>\`).join('')}</ul>\` : '<p class="ok">없습니다.</p>');
    $('ally').innerHTML = \`<h4 class="dh">동맹</h4>\${ul(grp('A'))}<h4 class="dh">전쟁</h4>\${ul(grp('W'))}\`; }
  const g = {};`;

export const patchDiplo = (tpl) => {
  // 목록
  const re = / {2}\{ const al = cur\.alliances;[\s\S]*?\n {2}const g = \{\};/;
  if (!re.test(tpl)) throw new Error('diplo-ui: 동맹 목록 자리');
  tpl = tpl.replace(re, () => PANEL);
  const H = '<h3 style="margin-top:12px">동맹</h3><div id="ally"></div>';
  must(tpl, H);
  tpl = tpl.replace(H, '<h3 style="margin-top:12px">외교</h3><div id="ally"></div>');
  // 지도: 고른 세력의 동맹은 밝게, 전쟁 상대는 붉은 테두리
  const AL =
    'const al = new Set(fsel === null ? [] : (cur.alliances ?? []).filter((p) => p.includes(fsel)).map((p) => (p[0] === fsel ? p[1] : p[0])));';
  must(tpl, AL);
  tpl = tpl.replace(
    AL,
    "const rel = (k) => new Set(fsel === null ? [] : (cur.diplomacy ?? []).filter((p) => p[2] === k && (p[0] === fsel || p[1] === fsel)).map((p) => (p[0] === fsel ? p[1] : p[0])));\n  const al = rel('A'), foe = rel('W');",
  );
  const FADE = "z.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel && !al.has(oi));";
  must(tpl, FADE);
  tpl = tpl.replace(
    FADE,
    "z.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel && !al.has(oi) && !foe.has(oi));\n      z.classList.toggle('foe', mode === 'faction' && fsel !== null && foe.has(oi));",
  );
  const NF = "n.g.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel && !al.has(oi));";
  must(tpl, NF);
  tpl = tpl.replace(
    NF,
    "n.g.classList.toggle('fade', mode === 'faction' && fsel !== null && oi !== fsel && !al.has(oi) && !foe.has(oi));",
  );
  // 모양
  const ST = '</style>';
  must(tpl, ST);
  tpl = tpl.replace(
    ST,
    '.zone.foe { stroke: var(--src-field); stroke-width: 2px }\n.dsrc { font-size: 10.5px; color: var(--warn); border: 1px solid currentColor; border-radius: 2px; padding: 0 3px; white-space: nowrap }\n.dh { margin: 8px 0 0; font: 600 12px var(--body); color: var(--muted) }\n</style>',
  );
  const LG = '<span>점선 길 = 새로 만든 도로</span>';
  must(tpl, LG);
  tpl = tpl.replace(LG, LG + '<span>세력을 고르면 동맹은 밝게, 전쟁 상대는 붉은 테두리</span>');
  return tpl;
};
