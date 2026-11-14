// 고평릉 IF 2종. 기준은 N24022(249년 3월)의 세력도이며 위의 땅과 인물을 나눈다.
const REVIVE = '조상 조희 조훈 하안 필궤 이승 환범 등양 정밀 하후현 하후패';
function setup(ctx, defs) {
  const { facInfo, facRow, pickAt, y, COLOR } = ctx;
  const weiFid = [...facInfo.values()].find((f) => f.key === 'cao').fid;
  const wei = facInfo.get(weiFid);
  const mk = (fid, key, name, rulerName) => {
    const r = pickAt(rulerName, y);
    facRow.set(fid, r);
    facInfo.set(fid, { fid, key, name, ruler: r.id, rulerLabel: r.label, color: COLOR[key] });
    return fid;
  };
  const made = {};
  for (const d of defs)
    made[d.key] = d.key === 'cao' ? weiFid : mk(100 + Object.keys(made).length, d.key, d.name, d.ruler);
  if (defs.some((d) => d.key === 'cao')) {
    const d = defs.find((x) => x.key === 'cao');
    const r = pickAt(d.ruler, y);
    wei.name = d.name;
    wei.ruler = r.id;
    wei.rulerLabel = r.label;
    facRow.set(weiFid, r);
  }
  return { weiFid, made };
}
function assignHeroes(ctx, made, heroes) {
  const { placed, pickAt, y } = ctx;
  const missing = [];
  for (const [key, spec] of Object.entries(heroes)) {
    for (const seg of spec
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [city, names] = seg.split(':');
      for (const n of names.trim().split(/\s+/)) {
        const r = pickAt(n, y);
        if (!r) {
          missing.push(n);
          continue;
        }
        placed.set(r.id, { fac: made[key], city, src: '지정', rank: 2 });
      }
    }
  }
  return missing;
}
function followCity(ctx, weiFid) {
  // 위 소속 인물은 자기 도시의 새 주인을 따른다
  const { owner, placed, facInfo } = ctx;
  const newIds = new Set([...facInfo.keys()].filter((f) => f === weiFid || f >= 100));
  for (const p of placed.values()) {
    if (p.fac !== weiFid || p.src === '지정') continue;
    const o = owner.get(p.city);
    if (o !== undefined && newIds.has(o)) p.fac = o;
  }
}
function bfsSplit(ctx, weiFid, seeds, nb) {
  // 씨앗 도시에서 도로를 따라 번갈아 넓혀 위의 땅을 나눈다
  const { owner } = ctx;
  const wei = new Set([...owner].filter(([, f]) => f === weiFid).map(([c]) => c));
  const front = seeds.map(([fid, cities]) => ({ fid, q: [...cities] }));
  const seen = new Set();
  for (const { fid, q } of front)
    for (const c of q) {
      seen.add(c);
      owner.set(c, fid);
      wei.delete(c);
    }
  let any = true;
  while (any) {
    any = false;
    for (const f of front) {
      const next = [];
      for (const c of f.q)
        for (const n of nb.get(c))
          if (wei.has(n) && !seen.has(n)) {
            seen.add(n);
            owner.set(n, f.fid);
            wei.delete(n);
            next.push(n);
            any = true;
          }
      f.q = next;
    }
  }
}
export const IFS = [
  {
    id: 'g249a',
    base: 22,
    type: 'IF',
    month: 1,
    title: '환범의 계책',
    allEra: false,
    divergence: '조상이 환범의 말을 듣고 황제를 허창으로 옮긴다',
    source: ['三國志 卷9', '範說爽使車駕幸許昌，招外兵。'],
    premise:
      '쿠데타 실패판. 사마의가 낙양 성문을 닫았지만 황제는 허창으로 빠져나갔고 천하의 병사가 조서를 따른다. 사마의는 수도 하나로 반역자가 되어 버틴다.',
    apply(ctx, { nb }) {
      const { owner } = ctx;
      const { weiFid, made } = setup(ctx, [
        { key: 'cao', name: '조상', ruler: '조상' },
        { key: 'sima', name: '사마의', ruler: '사마의' },
      ]);
      for (const c of ['낙양', '호로관', '함곡관', '홍농', '숭산', '동관']) owner.set(c, made.sima);
      ctx.missing = assignHeroes(ctx, made, {
        cao: '허창:조방 조상 조희 조훈 환범 하안 필궤 이승 등양 정밀; 장안:하후현 하후패 곽회 진태; 수춘:왕릉 문흠; 합비:제갈탄 관구검',
        sima: '낙양:사마의 사마사 사마소 사마부 장제 고유 왕관 가충',
      });
      followCity(ctx, weiFid);
      void nb;
    },
  },
  {
    id: 'g249b',
    base: 22,
    type: 'IF',
    month: 1,
    title: '두 개의 위',
    allEra: false,
    divergence: '낙양은 사마의가 잡았지만 황제는 허창으로 달아나 조정이 둘로 갈린다',
    source: ['三國志 卷9', '範說爽使車駕幸許昌，招外兵。爽兄弟猶豫未決'],
    premise:
      '절반의 성공판. 낙양과 하북은 사마의, 허창과 회남은 황제를 끼고 선 조상의 땅이 된다. 관서의 하후현은 어느 쪽에도 쉽게 붙지 못한다. 촉과 오까지 다섯 세력의 판이 열린다.',
    apply(ctx, { nb }) {
      const { weiFid, made } = setup(ctx, [
        { key: 'cao', name: '조상', ruler: '조상' },
        { key: 'sima', name: '사마의', ruler: '사마의' },
        { key: 'xiahou', name: '하후현', ruler: '하후현' },
      ]);
      bfsSplit(
        ctx,
        weiFid,
        [
          [made.sima, ['낙양', '업', '계']],
          [weiFid, ['허창', '수춘', '완']],
          [made.xiahou, ['장안', '오장원', '진창', '천수']],
        ],
        nb,
      );
      ctx.missing = assignHeroes(ctx, made, {
        cao: '허창:조방 조상 조희 조훈 환범 하안 필궤 이승 등양 정밀; 수춘:왕릉 문흠 관구검; 합비:제갈탄',
        sima: '낙양:사마의 사마사 사마소 사마부 장제 고유 왕관 가충 등애; 업:왕창 왕기',
        xiahou: '장안:하후현 하후패 곽회 진태',
      });
      followCity(ctx, weiFid);
    },
  },
];
void REVIVE;
