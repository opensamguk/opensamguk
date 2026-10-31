// 장수 생성 화면의 "이 장수는" 첩 (INT-20). 지금 능력치에서 가장 높은 것과 낮은 것을 고정 문장으로 보인다.
// 보이기만 하는 글이다. 규칙 판단은 서버가 한다.
import { FIVE_STATS, STATS, type CreationRules, type StatKey, type StatValues } from './createForm';

const STRONG: Record<StatKey, string> = {
  leadership: '통솔이 높아 많은 병력을 지휘하고 받는 피해를 줄입니다.',
  strength: '무력이 높아 직접 싸울 때 피해를 크게 줍니다.',
  intel: '지력이 높아 기술 연구와 화계에 강합니다.',
  politics: '정치가 높아 개간·상업 같은 내정에 강합니다.',
  charm: '매력이 높아 모병 비용이 적게 들고 민심을 잘 얻습니다.',
};

const WEAK: Record<StatKey, string> = {
  leadership: '통솔이 낮아 지휘할 수 있는 병력이 적습니다.',
  strength: '무력이 낮아 직접 싸우면 피해를 적게 줍니다.',
  intel: '지력이 낮아 연구와 계략이 더딥니다.',
  politics: '정치가 낮아 내정 효과가 작습니다.',
  charm: '매력이 낮아 모병 비용이 많이 듭니다.',
};

export const EVEN_TEXT = '능력치가 고릅니다. 어느 명령이든 무난하게 씁니다.';

export interface StatSummary {
  strong: string;
  caution: string | null;
}

// 정수가 아닌 칸이 있으면 null. 같은 값이면 앞 능력치(통솔·무력·지력·정치·매력 순)를 고른다.
export function summarizeStats(values: StatValues, rules: Pick<CreationRules, 'count'>): StatSummary | null {
  const fields = rules.count === 5 ? FIVE_STATS : STATS;
  const numbers = fields.map((stat) => (values[stat.key]?.trim() ? Number(values[stat.key]) : Number.NaN));
  if (numbers.some((n) => !Number.isInteger(n))) return null;
  let high = 0;
  let low = 0;
  numbers.forEach((n, i) => {
    if (n > numbers[high]!) high = i;
    if (n < numbers[low]!) low = i;
  });
  if (numbers[high] === numbers[low]) return { strong: EVEN_TEXT, caution: null };
  return { strong: STRONG[fields[high]!.key], caution: WEAK[fields[low]!.key] };
}

// −/+ 버튼이 넣을 다음 값. 정수가 아니거나 범위·남은 점수를 넘으면 null(버튼을 막는다).
export function stepStat(
  value: string | undefined,
  delta: 1 | -1,
  rules: Pick<CreationRules, 'min' | 'max'>,
  remaining: number,
): string | null {
  const n = value?.trim() ? Number(value) : Number.NaN;
  if (!Number.isInteger(n)) return null;
  // 범위 밖 값은 한 번 누르면 가장 가까운 끝으로 들어온다.
  if (delta < 0) return n <= rules.min ? null : String(Math.min(n - 1, rules.max));
  if (n >= rules.max || remaining <= 0) return null;
  return String(Math.max(n + 1, rules.min));
}
