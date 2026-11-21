import fs from 'node:fs';
const dir = process.argv[2];
const f = fs
  .readdirSync(dir)
  .map((n) => [fs.statSync(`${dir}/${n}`).size, n])
  .sort((a, c) => c[0] - a[0])[0][1];
const p = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
const dt = p.timeDeltas;
const self = new Map();
const byId = new Map(p.nodes.map((n) => [n.id, n]));
p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + dt[i]));
const key = (n) => {
  const u = n.callFrame.url.replace(/^.*\/(apps|packages)\//, '$1/').replace(/^.*node_modules\//, 'nm/');
  return `${n.callFrame.functionName || '(anon)'} ${u}:${n.callFrame.lineNumber + 1}`;
};
const total = [...self.values()].reduce((a, c) => a + c, 0);
const fn = new Map();
for (const [id, t] of self) {
  const k = key(byId.get(id));
  fn.set(k, (fn.get(k) ?? 0) + t);
}
console.log('total s', (total / 1e6).toFixed(1));
for (const [k, t] of [...fn].sort((a, c) => c[1] - a[1]).slice(0, 22))
  console.log(((t / total) * 100).toFixed(1) + '%', (t / 1e6).toFixed(1) + 's', k);
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map();
for (const [id, t] of self) {
  const seen = new Set();
  let c = id;
  while (c != null) {
    const k = key(byId.get(c));
    if (!seen.has(k)) {
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + t);
    }
    c = parent.get(c);
  }
}
console.log('--- 포함 시간');
for (const [k, t] of [...incl]
  .filter(([k]) => /apps\/|packages\//.test(k))
  .sort((a, c) => c[1] - a[1])
  .slice(0, 26))
  console.log(((t / total) * 100).toFixed(1) + '%', k);
