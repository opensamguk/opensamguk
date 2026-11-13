import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { displayName } from '../game/names';

// 장수 동향 · 중원 정세 · 전투 기록의 글줄 만들기 (INT-25 기록 3칸, INT-26 records.activity·records.battles).
// 서버는 최신순으로 30개씩 주고 커서로 이어 준다. 여기서는 받은 쪽들을 한 목록으로 펴고, 달마다 묶고, 문장을 만든다.

type Outputs = inferRouterOutputs<AppRouter>['records'];
export type ActivityItem = Outputs['activity']['items'][number];
export type BattleItem = Outputs['battles']['items'][number];
export type WorldItem = Outputs['world']['items'][number];
export type ReputationItem = Extract<ActivityItem, { source: 'reputation' }>;

export interface FeedLine {
  key: string;
  tick: number;
  year: number;
  month: number;
  source: 'reputation' | 'nation' | 'review';
  kind: string;
  text: string;
  // 장수 동향의 소속 국가. 재야면 null, 국가 사건·월단평은 없다.
  portrait?: { id: number | null; name: string };
  nation?: { name: string; color: string } | null;
}

export interface FeedMonth {
  key: string;
  year: number;
  month: number;
  lines: FeedLine[];
}

// 받은 쪽들을 한 줄로 편다. 실시간 재조회 중 쪽 경계가 밀려 같은 항목이 두 번 오더라도 한 번만 남긴다.
export function flattenPages<T>(pages: ReadonlyArray<{ items: readonly T[] }>, keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages)
    for (const item of page.items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  return out;
}

export const activityKey = (item: ActivityItem) => `${item.source}:${item.id}`;
export const battleKey = (item: BattleItem) => `${item.tick}:${item.attackerId}`;

// 받침이 있으면 '이', 없으면 '가'. 한글이 아닌 끝 글자는 '가'로 둔다.
export function subject(name: string) {
  const code = [...name].at(-1)?.charCodeAt(0) ?? 0;
  return name + (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '이' : '가');
}

// 평판 사건 한 건의 문장. 서버 원장에는 문장이 없어 종류·이름·공개 도시로 만든다. 고르는 문장은 늘 같다.
export function reputationSentence(item: Pick<ReputationItem, 'kind' | 'data'>): string {
  const who = subject(displayName(item.data.name));
  const city = item.data.city?.name;
  switch (item.kind) {
    case 'conquest':
      return city ? `${who} ${city} 점령을 이끌었다.` : `${who} 점령을 이끌었다.`;
    case 'victory':
      return city ? `${who} ${city} 교전에서 이겼다.` : `${who} 교전에서 이겼다.`;
    case 'defeat':
      return city ? `${who} ${city} 교전에서 졌다.` : `${who} 교전에서 졌다.`;
    case 'domestic':
      return `${who} 내정 목표를 채웠다.`;
    case 'betrayal':
      return `${who} 소속이나 조약의 약속을 끊었다.`;
  }
}

export function activityLine(item: ActivityItem): FeedLine {
  const base = { key: activityKey(item), tick: item.tick, year: item.year, month: item.month, kind: item.kind };
  if (item.source === 'nation') return { ...base, source: 'nation', text: item.text };
  const nation = item.data.nation;
  return {
    ...base,
    source: 'reputation',
    text: reputationSentence(item),
    portrait: { id: item.portraitId, name: displayName(item.data.name) },
    nation: nation ? { name: nation.name, color: nation.color } : null,
  };
}

// 연감에 실린 달의 월단평 머리글. 중원 정세 사건 사이에 그 달 정산 tick 자리로 끼운다.
export function reviewLines(items: readonly WorldItem[]): FeedLine[] {
  return items.flatMap((item) =>
    item.review
      ? [
          {
            key: `review:${item.tick}`,
            tick: item.tick,
            year: item.year,
            month: item.month,
            source: 'review' as const,
            kind: 'review',
            text: `월단평: ${item.review.headline}`,
          },
        ]
      : [],
  );
}

// 중원 정세 = 서버의 국가 사건(최신순) + 월단평 머리글. 사건이 더 남아 있으면 불러온 마지막 사건보다 오래된 머리글은
// 아직 보이지 않는다(더 보기를 누르면 그 자리에 나온다). 같은 tick이면 월단평을 먼저 쓴다.
export function worldTimeline(events: readonly FeedLine[], reviews: readonly FeedLine[], hasMore: boolean): FeedLine[] {
  const oldest = events.at(-1)?.tick;
  const shown = hasMore && oldest !== undefined ? reviews.filter((line) => line.tick >= oldest) : reviews;
  const rank = (line: FeedLine) => (line.source === 'review' ? 0 : 1);
  return [...events.map((line, index) => ({ line, index })), ...shown.map((line, index) => ({ line, index }))]
    .sort((a, b) => b.line.tick - a.line.tick || rank(a.line) - rank(b.line) || a.index - b.index)
    .map(({ line }) => line);
}

// 이어진 같은 연월끼리 한 줄로 묶는다. 목록은 이미 최신순이다.
export function groupByMonth(lines: readonly FeedLine[]): FeedMonth[] {
  const months: FeedMonth[] = [];
  for (const line of lines) {
    const last = months.at(-1);
    if (last && last.year === line.year && last.month === line.month) last.lines.push(line);
    else
      months.push({ key: `${line.year}-${line.month}:${line.key}`, year: line.year, month: line.month, lines: [line] });
  }
  return months;
}

// 사건이 아직 없을 때 메인 중원 정세에 쓰는 가장 최근 달의 세력 수.
export function yearbookSummary(item: Pick<WorldItem, 'nations' | 'cities'>): string {
  const nations = item.nations.filter((entry) => entry.cities > 0).length;
  const empty = item.cities.filter((city) => city.nationId === null).length;
  return `세력 ${nations}곳 · 공백지 ${empty}성`;
}

// 전투 기록 글에 든 장수 이름의 괄호를 뺀다 (D-085, displayName과 같은 규칙). 이름 뒤 띄어쓰기는 남긴다.
export function battleText(text: string): string {
  const stripped = text.replace(/[ \t]*[（(][^()（）]*[)）]/g, '').trim();
  return stripped === '' ? text : stripped;
}
