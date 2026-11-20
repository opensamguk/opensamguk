// 성 화면 사람의 말(시안 castle-panorama의 talkTo를 옮김, 2026-11-17 사용자 "시안 기능 전부 옮기기").
// 대사는 양식마다 한 꾸러미(cityTalk/<양식>.json, D:/codex-artifacts/int29-castle-panorama-20261116/export-web-talk.js가 만든다).
// 공통 대사는 없다(사용자 2026-11-16 "이거 끝나면 공통대사는 없는거야"). 꾸러미는 그 양식 화면을 열 때 따로 불러온다.
// 시안의 선택 사건과 무작위 사건(금, 군량, 민심을 바꾸는 것)은 옮기지 않았다. 게임 수치는 서버가 정한다.
import common from './cityTalk/common.json';

type Lines = readonly string[];
type Seasonal = Partial<Record<'base' | 'spring' | 'summer' | 'autumn' | 'winter' | 'water', Lines>>;
export interface TalkPack {
  talk: Record<string, Seasonal>;
  register: Record<string, Lines>;
  role: Record<string, { name: string; lines: Lines }>;
  build: Record<string, { name: string; before: string; during: string; after: string }>;
  situation: Record<string, Record<string, Lines>>;
  newPeople: Record<string, { name: string; lines: Lines }>;
  classLore: Record<string, Lines>;
  gosa: Record<string, Lines>;
  regionTalk: Record<string, Lines>;
  dialectReg: Record<string, Lines>;
  lore: { people: Lines; high: Record<string, Lines> };
  jokes: Lines;
  story: { lines: Lines; high: Record<string, Lines> };
}

const PACKS = import.meta.glob<{ default: TalkPack }>(['./cityTalk/*.json', '!./cityTalk/common.json']);
const loaded = new Map<string, TalkPack>();

/** 양식 꾸러미를 불러온다. 없는 양식은 중원 꾸러미. */
export async function loadTalk(style: string): Promise<TalkPack> {
  const hit = loaded.get(style);
  if (hit) return hit;
  const load = PACKS[`./cityTalk/${style}.json`] ?? PACKS['./cityTalk/central.json']!;
  const pack = (await load()).default;
  loaded.set(style, pack);
  return pack;
}

export const ACTOR_NAME: Readonly<Record<string, string>> = common.actorName;
/** 건물을 지으면 그 둘레를 오가는 사람의 그림 종류. */
export const ROLE_KIND: Readonly<Record<string, string>> = common.roleKind;
export const ANIMALS = ['dog', 'chicken', 'horse', 'sheep', 'ox', 'buffalo', 'pig', 'camel'] as const;
const isAnimal = (kind: string) => (ANIMALS as readonly string[]).includes(kind);

// 신분에 따른 말투(2026-11-16 사용자: "신분에 따라 말투도 다르게"). 듣는 이는 태수(플레이어).
const REGISTER_OF_KIND: Readonly<Record<string, string>> = {
  clerk: 'humble',
  peddler: 'humble',
  soldier: 'military',
  scholar: 'scholar',
  elder: 'elder',
  child: 'child',
};
const REGISTER_OF_ROLE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ['office', 'tally', 'arsenal', 'granary', 'market', 'grand_market', 'black_market', 'mint'].map((k) => [
      k,
      'humble',
    ]),
  ),
  ...Object.fromEntries(
    [
      'patrol',
      'barracks',
      'military_farm',
      'crossbow_tower',
      'repeating_tower',
      'catapult',
      'earthwork',
      'palisade',
      'fire_seed',
      'fire_ball',
      'rockfall',
      'beacon',
      'drum',
    ].map((k) => [k, 'military']),
  ),
  academy: 'scholar',
  stone_maze: 'scholar',
  clinic: 'elder',
  shrine: 'elder',
  bronze_terrace: 'elder',
  ...Object.fromEntries(['drill_ground', 'camp', 'fort', 'citadel', 'bastion'].map((k) => [k, 'officer'])),
};
export const REGISTER_NAME: Readonly<Record<string, string>> = {
  humble: '아랫사람',
  military: '병졸',
  scholar: '선비',
  elder: '어른',
  officer: '군관',
  child: '아이',
};
const LORE_KIND: Readonly<Record<string, string>> = {
  villager: 'farmer',
  woman: 'farmer',
  porter: 'farmer',
  peddler: 'peddler',
  clerk: 'humble',
  soldier: 'military',
  scholar: 'scholar',
  elder: 'elder',
  child: 'child',
};
const HIGH = new Set(['scholar', 'officer', 'elder']);

// 말끝 바꾸기: 표준어 대사(-습니다, -ㅂ니다로 끝남)만 신분 말투로 바꾸고 사투리 대사는 그대로 둔다.
const HB = 0xac00;
const jongOf = (ch: string) => (ch.charCodeAt(0) - HB) % 28;
const dropJong = (ch: string) => String.fromCharCode(ch.charCodeAt(0) - jongOf(ch));
export function shiftEnding(line: string, reg: string): string {
  return line
    .replace(/([가-힣]?)([가-힣])니다([.!]?)/g, (m, keep: string, syl: string, p: string) => {
      if (syl === '습') {
        const tail = { humble: '사옵니다', elder: '소', scholar: '네', military: '습니다', officer: '소' }[reg];
        return tail ? keep + tail + (reg === 'military' ? '!' : p || '.') : m;
      }
      if (jongOf(syl) !== 17) return m;
      const stem = dropJong(syl);
      if (reg === 'military') return `${keep}${syl}니다!`;
      if (reg === 'scholar' && stem === '이') return `${keep}일세${p || '.'}`;
      if ((reg === 'elder' || reg === 'officer') && stem === '이' && keep && jongOf(keep) === 0)
        return `${keep}요${p || '.'}`;
      const tail = { humble: '옵니다', elder: '오', scholar: '네', officer: '오' }[reg];
      return tail ? keep + stem + tail + (p || '.') : m;
    })
    .replace(/습([.!])/g, '$1');
}
function speakAs(line: string, reg: string | null, rnd: () => number): string {
  if (!reg || reg === 'child' || !/니다[.!]?$/.test(line)) return line;
  let out = shiftEnding(line, reg);
  if (reg === 'humble' && !out.startsWith('나리') && rnd() < 0.5) out = `나리, ${out}`;
  if (reg === 'military' && rnd() < 0.4) out = `장군님! ${out}`;
  return out;
}

/** 대사 속 이름 자리({ruler} 군주, {taesu} 태수, {enemy} 적, {general} 성 안 장수). */
export interface TalkContext {
  ruler: string;
  taesu: string;
  enemy: string;
  generals: readonly string[];
}
export interface Speaker {
  kind: string;
  /** 건물 인물이면 그 건물 키. */
  role?: string | undefined;
  /** 공사판 일꾼이면 짓는 건물 키. */
  building?: string | undefined;
}
export interface TalkWorld {
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  water: boolean;
  /** 켜진 상황(홍수, 역병, 전투 등). */
  conds: readonly string[];
  ctx: TalkContext;
}

export function fillCtx(text: string, ctx: TalkContext, rnd: () => number): string {
  const general = ctx.generals.length ? ctx.generals[Math.floor(rnd() * ctx.generals.length)]! : ctx.taesu;
  return text
    .replaceAll('{ruler}', ctx.ruler)
    .replaceAll('{taesu}', ctx.taesu)
    .replaceAll('{enemy}', ctx.enemy)
    .replaceAll('{general}', general);
}
const pick = <T>(list: readonly T[], rnd: () => number): T | undefined => list[Math.floor(rnd() * list.length)];

/** 공사 대사(짓기 전, 짓는 중, 다 지은 뒤). */
export function buildLine(pack: TalkPack, key: string, when: 'before' | 'during' | 'after') {
  const t = pack.build[key];
  return t ? { who: t.name, text: t[when] } : null;
}

/** 사람(또는 동물)을 눌렀을 때 하는 말. 시안 talkTo와 같은 고르기 규칙(사건 제외). */
export function talkTo(
  pack: TalkPack,
  a: Speaker,
  world: TalkWorld,
  rnd: () => number = Math.random,
): { who: string; text: string } {
  if (a.kind === 'worker' && a.building) {
    const b = buildLine(pack, a.building, 'during');
    if (b) return b;
  }
  const T = pack.talk[a.kind] ?? {};
  const R = pack.regionTalk;
  const animal = isAnimal(a.kind);
  const bucket = ['child', 'elder', 'soldier'].includes(a.kind) ? a.kind : animal ? null : 'people';
  let lines: string[] = [...(T.base ?? []), ...(T[world.season] ?? []), ...(world.water ? (T.water ?? []) : [])];
  if (bucket && R[bucket]) lines = [...lines, ...R[bucket]!, ...R[bucket]!];
  let who = ACTOR_NAME[a.kind] ?? '';
  const RL = a.role ? pack.role[a.role] : undefined;
  if (RL) {
    who = RL.name;
    lines = [...RL.lines, ...RL.lines, ...(R.people ?? []).slice(0, 2)];
  }
  // 상황 대사를 먼저(70%)
  const sb = ['child', 'elder', 'soldier', 'peddler'].includes(a.kind) ? a.kind : 'people';
  const sl = animal ? [] : world.conds.flatMap((c) => pack.situation[c]?.[sb] ?? pack.situation[c]?.people ?? []);
  if (sl.length && rnd() < 0.7) return { who, text: fillCtx(pick(sl, rnd)!, world.ctx, rnd) };
  const reg = animal ? null : ((a.role && REGISTER_OF_ROLE[a.role]) ?? REGISTER_OF_KIND[a.kind] ?? null);
  if (!animal) {
    const dl = reg ? (pack.dialectReg[reg] ?? []) : [];
    const cls = (reg && pack.classLore[reg]) ?? pack.classLore[LORE_KIND[a.kind] ?? ''] ?? [];
    lines = [
      ...lines,
      ...(reg ? (pack.register[reg] ?? []) : []),
      ...dl,
      ...dl,
      ...pack.lore.people,
      ...pack.jokes,
      ...cls,
      ...pack.story.lines,
      ...pack.story.lines,
    ];
    // 높은 신분은 35% 확률로 고사나 사료 이야깃거리 한 줄
    if (reg && HIGH.has(reg) && rnd() < 0.35) {
      const hi = pack.story.high[reg] ?? [];
      const local = pack.lore.high[reg] ?? [];
      const pool = hi.length && rnd() < 0.5 ? hi : [...local, ...local, ...(pack.gosa[reg] ?? [])];
      const g = pick(pool, rnd);
      if (g) return { who: `${who} (${REGISTER_NAME[reg]})`, text: fillCtx(g, world.ctx, rnd) };
    }
  }
  const said = lines.length ? fillCtx(pick(lines, rnd)!, world.ctx, rnd) : '...';
  return { who, text: speakAs(said, reg, rnd) };
}
