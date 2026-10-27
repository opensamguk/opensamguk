// 장수 생성 입력 검사. 화면에서 먼저 막고, 최종 판단은 서버(general.create)가 월드 규칙으로 한다.
// 능력치 규칙은 general.mine의 해당 월드 생성 규칙을 쓴다. 기존 3능력치도 유지한다.

export const STAT_RULES = { total: 165, min: 15, max: 80 } as const;

export const STATS = [
  { key: 'leadership', label: '통솔' },
  { key: 'strength', label: '무력' },
  { key: 'intel', label: '지력' },
] as const;
export const FIVE_STATS = [...STATS, { key: 'politics', label: '정치' }, { key: 'charm', label: '매력' }] as const;
export type CreationRules = { count?: number; total: number; min: number; max: number };
export const FIVE_STAT_PRESETS = [
  { name: '지휘관', values: [90, 60, 55, 35, 35] },
  { name: '무장', values: [65, 90, 45, 30, 45] },
  { name: '책사', values: [50, 30, 90, 60, 45] },
  { name: '내정가', values: [35, 25, 60, 90, 65] },
  { name: '인재 담당', values: [40, 30, 55, 60, 90] },
] as const;

export type StatKey = (typeof FIVE_STATS)[number]['key'];
export type StatValues = Record<(typeof STATS)[number]['key'], string> & Partial<Record<'politics' | 'charm', string>>;

// M1은 초상 목록 화면 없이 기본 이미지 몇 개 중 고르거나 고르지 않는다 (T1-15 계획).
export const PORTRAIT_CHOICES = [10001, 10002, 10003, 10004, 10005, 10006] as const;

const NAME_PATTERN = /^[가-힣\p{Script=Han}A-Za-z0-9]+$/u;

export function normalizeName(name: string): string {
  return name.normalize('NFC').trim();
}

export interface CreationCheck {
  name: string;
  stats: (Record<(typeof STATS)[number]['key'], number> & Partial<Record<'politics' | 'charm', number>>) | null;
  sum: number;
  remaining: number;
  problems: string[];
}

export function checkCreation(rawName: string, values: StatValues, rules: CreationRules = STAT_RULES): CreationCheck {
  const name = normalizeName(rawName);
  const problems: string[] = [];
  const length = [...name].length;
  if (length === 0) problems.push('이름을 입력하세요.');
  else if (length > 6) problems.push('이름은 6글자까지입니다.');
  else if (!NAME_PATTERN.test(name)) problems.push('이름은 한글·한자·영문·숫자만 씁니다.');

  const fields = rules.count === 5 ? FIVE_STATS : STATS;
  const numbers = fields.map((stat) => Number(values[stat.key]));
  const sum = numbers.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const remaining = rules.total - sum;
  let valid = true;
  fields.forEach((stat, i) => {
    const n = numbers[i]!;
    if (!values[stat.key]?.trim() || !Number.isInteger(n)) {
      problems.push(`${stat.label}에 정수를 넣으세요.`);
      valid = false;
    } else if (n < rules.min || n > rules.max) {
      problems.push(`${stat.label}${stat.key === 'politics' ? '는' : '은'} ${rules.min}~${rules.max} 사이여야 합니다.`);
      valid = false;
    }
  });
  if (remaining > 0) problems.push(`능력치를 ${remaining}점 더 나눠야 합니다.`);
  else if (remaining < 0) problems.push(`능력치 합계가 ${-remaining}점 넘습니다. 합계는 ${rules.total}입니다.`);
  const stats =
    valid && remaining === 0
      ? {
          leadership: numbers[0]!,
          strength: numbers[1]!,
          intel: numbers[2]!,
          ...(rules.count === 5 ? { politics: numbers[3]!, charm: numbers[4]! } : {}),
        }
      : null;
  return { name, stats, sum, remaining, problems };
}
