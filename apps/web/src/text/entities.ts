// 글 속 이름 찾기 (INT-29, 사용자 2026-11-14: 로그나 모든 텍스트에 장수·세력 이름 등에 효과를).
// 서버 기록은 평문이라, 월드의 장수·세력·도시 이름 목록으로 글 안에서 이름을 찾아 조각으로 나눈다.
// - 긴 이름부터 맞춘다(하내·하내군 같은 겹침에서 긴 쪽).
// - 이름 앞은 글의 시작이거나 한글 음절이 아닌 글자여야 한다("자유비행" 안의 "유비"를 잡지 않게).
// - 한 글자 이름(위·촉·오, 업·완)은 뒤가 띄어쓰기·문장부호·끝이거나 조사일 때만 잡는다.
// - 부호가 붙은 숫자(+1,200 / -300)와 그냥 숫자도 조각으로 나눈다.

export type EntityKind = 'general' | 'nation' | 'city';
export interface TextEntity {
  kind: EntityKind;
  name: string;
  /** 장수: 초상 번호 */
  portraitId?: number | null;
  /** 세력색(장수·도시는 소속 세력색) */
  color?: string | null;
  /** 장수 id, 국가 id, 도시 key */
  id?: number;
}
export type TextPiece =
  | { type: 'text'; text: string }
  | { type: 'entity'; text: string; entity: TextEntity }
  | { type: 'number'; text: string; sign: -1 | 0 | 1 };

const HANGUL = /[가-힣]/;
// 한 글자 이름 뒤에 올 수 있는 조사.
const PARTICLES = [
  '에게서',
  '에게',
  '에서',
  '으로',
  '로',
  '의',
  '가',
  '이',
  '는',
  '은',
  '를',
  '을',
  '와',
  '과',
  '도',
  '만',
  '에',
  '께',
  '군',
  '나라',
  '국',
];
// 같은 이름이 둘 이상 종류에 있으면 이 순서로 고른다(세력 이름이 군주 이름인 경우가 많아 세력을 먼저).
const PRIORITY: Record<EntityKind, number> = { nation: 0, general: 1, city: 2 };

export interface EntityMatcher {
  pieces(text: string): TextPiece[];
}

export function buildMatcher(entities: readonly TextEntity[]): EntityMatcher {
  // 첫 글자별로 이름 후보를 긴 순서로 모은다.
  const byFirst = new Map<string, TextEntity[]>();
  const seen = new Map<string, TextEntity>();
  for (const entity of entities) {
    const name = entity.name.trim();
    if (name.length === 0) continue;
    const prev = seen.get(name);
    if (prev && PRIORITY[prev.kind] <= PRIORITY[entity.kind]) continue;
    seen.set(name, { ...entity, name });
  }
  for (const entity of seen.values()) {
    const first = entity.name[0]!;
    const list = byFirst.get(first) ?? [];
    list.push(entity);
    byFirst.set(first, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.name.length - a.name.length);

  const rightOk = (text: string, end: number) => {
    if (end >= text.length) return true;
    const next = text[end]!;
    if (!HANGUL.test(next)) return true;
    return PARTICLES.some((p) => text.startsWith(p, end));
  };

  return {
    pieces(text) {
      const out: TextPiece[] = [];
      let buffer = '';
      const flush = () => {
        if (buffer) out.push({ type: 'text', text: buffer });
        buffer = '';
      };
      let i = 0;
      while (i < text.length) {
        const ch = text[i]!;
        const leftOk = i === 0 || !HANGUL.test(text[i - 1]!);
        // 숫자: 앞이 글자 경계일 때만(이름 안 숫자 아님). 부호 +/−/- 를 함께 잡는다.
        const numberMatch =
          leftOk || !/[0-9A-Za-z]/.test(text[i - 1] ?? '')
            ? /^([+\-−]?)(\d[\d,]*(?:\.\d+)?)/.exec(text.slice(i))
            : null;
        if (numberMatch && (numberMatch[1] === '' || i === 0 || /[\s(:·,]/.test(text[i - 1]!))) {
          flush();
          const sign = numberMatch[1] === '+' ? 1 : numberMatch[1] ? -1 : 0;
          out.push({ type: 'number', text: numberMatch[0], sign });
          i += numberMatch[0].length;
          continue;
        }
        if (leftOk) {
          const hit = byFirst
            .get(ch)
            ?.find((entity) => text.startsWith(entity.name, i) && (entity.name.length > 1 || rightOk(text, i + 1)));
          if (hit) {
            flush();
            out.push({ type: 'entity', text: hit.name, entity: hit });
            i += hit.name.length;
            continue;
          }
        }
        buffer += ch;
        i += 1;
      }
      flush();
      return out;
    },
  };
}
