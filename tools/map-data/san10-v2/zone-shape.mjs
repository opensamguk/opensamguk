// 구역 모양 측정: 주축 길이와 평균 폭(넓이 / 길이)
import fs from 'node:fs';
import { S } from './paths.mjs';
const g = JSON.parse(fs.readFileSync(`${S}/data/zones-grid.json`, 'utf8'));
const st = g.sites.map((name) => ({ name, n: 0, sx: 0, sy: 0, xx: 0, yy: 0, xy: 0 }));
g.rows.forEach((row, y) => {
  for (let i = 0; i < row.length; i += 3) {
    const s = st[row[i + 2] - 1];
    for (let x = row[i]; x < row[i] + row[i + 1]; x++) {
      s.n++;
      s.sx += x;
      s.sy += y;
      s.xx += x * x;
      s.yy += y * y;
      s.xy += x * y;
    }
  }
});
const out = st.map((s) => {
  const mx = s.sx / s.n,
    my = s.sy / s.n,
    a = s.xx / s.n - mx * mx,
    c = s.yy / s.n - my * my,
    b = s.xy / s.n - mx * my;
  const t = (a + c) / 2,
    d = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = t + d,
    l2 = Math.max(t - d, 0.01);
  const len = Math.sqrt(12 * l1);
  return {
    name: s.name,
    area: s.n,
    len: Math.round(len),
    width: +(s.n / len).toFixed(1),
    ratio: +Math.sqrt(l1 / l2).toFixed(1),
  };
});
const thin = out.filter((z) => z.ratio >= 3 && z.area >= 100).sort((p, q) => q.ratio - p.ratio);
console.log('ratio>=3', thin.length, 'ratio>=5', thin.filter((z) => z.ratio >= 5).length);
console.log(
  thin
    .slice(0, 18)
    .map((z) => `${z.name} 비${z.ratio} 길이${z.len} 폭${z.width} 넓이${z.area}`)
    .join('\n'),
);
fs.writeFileSync(`${S}/data/zone-shape.json`, JSON.stringify(out));
// 구역별 조각 수(4방향 연결). 떨어진 조각이 있는지 본다
{
  const W = g.width,
    H = g.height;
  const lab = new Uint16Array(W * H);
  g.rows.forEach((row, y) => {
    for (let i = 0; i < row.length; i += 3) lab.fill(row[i + 2], y * W + row[i], y * W + row[i] + row[i + 1]);
  });
  const seen = new Uint8Array(W * H);
  const parts = new Map();
  for (let c = 0; c < lab.length; c++) {
    if (!lab[c] || seen[c]) continue;
    const l = lab[c];
    const q = [c];
    seen[c] = 1;
    let n = 0;
    while (q.length) {
      const v = q.pop();
      n++;
      const x = v % W;
      for (const m of [x > 0 ? v - 1 : -1, x < W - 1 ? v + 1 : -1, v - W, v + W])
        if (m >= 0 && m < lab.length && !seen[m] && lab[m] === l) {
          seen[m] = 1;
          q.push(m);
        }
    }
    if (!parts.has(l)) parts.set(l, []);
    parts.get(l).push(n);
  }
  const frag = [...parts].filter(([, p]) => p.length > 1).map(([l, p]) => [g.sites[l - 1], p.sort((a, b) => b - a)]);
  const big = frag.filter(([, p]) => p[1] >= 30);
  console.log(
    '조각 있는 구역',
    frag.length,
    '30칸 이상 떨어진 조각',
    big.length,
    big
      .slice(0, 16)
      .map(([n, p]) => `${n}:${p.slice(0, 4).join('+')}`)
      .join(' '),
  );
}
