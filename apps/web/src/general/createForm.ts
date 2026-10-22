// 장수 생성 입력 검사. 화면에서 먼저 막고, 최종 판단은 서버(general.create)가 월드 규칙으로 한다.
// 능력치 규칙: 합계 165, 각각 15~80 (resources/scenario/default.json의 stat). 월드별 규칙을 화면에 주는 API는 아직 없다.

export const STAT_RULES = { total: 165, min: 15, max: 80 } as const;

export const STATS = [
  { key: 'leadership', label: '통솔' },
  { key: 'strength', label: '무력' },
  { key: 'intel', label: '지력' },
] as const;

export type StatKey = (typeof STATS)[number]['key'];
export type StatValues = Record<StatKey, string>;

// M1은 초상 목록 화면 없이 기본 이미지 몇 개 중 고르거나 고르지 않는다 (T1-15 계획).
export const PORTRAIT_CHOICES = [10001, 10002, 10003, 10004, 10005, 10006] as const;

const NAME_PATTERN = /^[가-힣\p{Script=Han}A-Za-z0-9]+$/u;

export function normalizeName(name: string): string {
  return name.normalize('NFC').trim();
}

export interface CreationCheck {
  name: string;
  stats: Record<StatKey, number> | null;
  sum: number;
  remaining: number;
  problems: string[];
}

export function checkCreation(rawName: string, values: StatValues): CreationCheck {
  const name = normalizeName(rawName);
  const problems: string[] = [];
  const length = [...name].length;
  if (length === 0) problems.push('이름을 입력하세요.');
  else if (length > 6) problems.push('이름은 6글자까지입니다.');
  else if (!NAME_PATTERN.test(name)) problems.push('이름은 한글·한자·영문·숫자만 씁니다.');

  const numbers = STATS.map((stat) => Number(values[stat.key]));
  const sum = numbers.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const remaining = STAT_RULES.total - sum;
  let valid = true;
  STATS.forEach((stat, i) => {
    const n = numbers[i]!;
    if (values[stat.key].trim() === '' || !Number.isInteger(n)) {
      problems.push(`${stat.label}에 정수를 넣으세요.`);
      valid = false;
    } else if (n < STAT_RULES.min || n > STAT_RULES.max) {
      problems.push(`${stat.label}은 ${STAT_RULES.min}~${STAT_RULES.max} 사이여야 합니다.`);
      valid = false;
    }
  });
  if (remaining > 0) problems.push(`능력치를 ${remaining}점 더 나눠야 합니다.`);
  else if (remaining < 0) problems.push(`능력치 합계가 ${-remaining}점 넘습니다. 합계는 ${STAT_RULES.total}입니다.`);
  const stats =
    valid && remaining === 0 ? { leadership: numbers[0]!, strength: numbers[1]!, intel: numbers[2]! } : null;
  return { name, stats, sum, remaining, problems };
}
