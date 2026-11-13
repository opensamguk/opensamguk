// 장수 생성의 유산 배분 안내 (T4-96 AC-P2-33). 배분 값을 바꾸지 않고 막힘 이유와 문제 문장만 만든다.
// 잔액은 general.mine이 준 안내값이다. 최종 판정은 서버·엔진(readHeritageAllocation, 잔액 차감)이 한다.
import { FIVE_STATS, STATS, type CreationRules, type StatKey, type StatValues } from './createForm';

export type HeritageRules = { balance: number; perStat: number; perGeneral: number };
// 0이 아닌 능력치만 키로 둔다. 그대로 general.create의 heritage가 된다.
export type HeritageBonus = Partial<Record<StatKey, number>>;

export interface HeritageRow {
  key: StatKey;
  label: string;
  base: number | null;
  bonus: number;
  final: number | null;
  // + 단추를 막는 이유. null이면 더 올릴 수 있다.
  why: string | null;
}

export interface HeritageCheck {
  rows: HeritageRow[];
  spent: number;
  after: number;
  problems: string[];
}

export const HERITAGE_STALE = '유산 잔액을 다시 확인하세요.';
// 즉시 응답(CONFLICT)의 잔액 부족 문구. 화면은 rules를 읽지 않으므로 문구만 두고 tools/heritage-ui-contract.test.ts가 rules와 같은지 본다.
export const HERITAGE_INSUFFICIENT_MESSAGE = '유산 포인트가 부족합니다.';

const integer = (value: string | undefined) => (value?.trim() ? Number(value) : Number.NaN);

export function checkHeritage(
  bonus: HeritageBonus,
  values: StatValues,
  rules: CreationRules,
  heritage: HeritageRules,
  stale: boolean,
  birthCost = 0,
): HeritageCheck {
  const fields: readonly { key: StatKey; label: string }[] = rules.count === 5 ? FIVE_STATS : STATS;
  const spent = fields.reduce((sum, stat) => sum + (bonus[stat.key] ?? 0), 0);
  const total = spent + birthCost;
  const problems: string[] = stale ? [HERITAGE_STALE] : [];
  const rows = fields.map(({ key, label }): HeritageRow => {
    const n = integer(values[key]);
    const b = bonus[key] ?? 0;
    const base = Number.isInteger(n) ? n : null;
    const final = base === null ? null : base + b;
    let why: string | null = null;
    if (base === null) why = `기본 ${label}에 정수를 넣으면 유산을 붙일 수 있습니다.`;
    else if (b >= heritage.perStat) why = `능력치 하나에는 +${heritage.perStat}까지입니다.`;
    else if (final! >= rules.max) why = `최종값이 최대 ${rules.max}에 닿아 더 올릴 수 없습니다.`;
    else if (spent >= heritage.perGeneral) why = `한 장수에는 합계 +${heritage.perGeneral}까지입니다.`;
    else if (total >= heritage.balance)
      why =
        heritage.balance === 0 ? '보유한 유산 포인트가 없습니다.' : `보유 ${heritage.balance}점을 모두 배분했습니다.`;
    if (b > 0 && final !== null && final > rules.max)
      problems.push(`${label} 최종값은 ${final}입니다. 최대 ${rules.max}까지라 유산이나 기본값을 줄이세요.`);
    return { key, label, base, bonus: b, final, why };
  });
  if (total > heritage.balance)
    problems.push(
      `유산 배분은 ${total}점이고 보유는 ${heritage.balance}점입니다. ${total - heritage.balance}점 줄이세요.`,
    );
  return { rows, spent, after: heritage.balance - total, problems };
}

// 「이 장수는」 요약용 최종 능력치. 보낼 값(기본 능력치)에는 쓰지 않는다.
export function withBonus(values: StatValues, bonus: HeritageBonus): StatValues {
  const out = { ...values };
  for (const [key, amount] of Object.entries(bonus) as [StatKey, number][]) {
    const n = integer(out[key]);
    if (Number.isInteger(n)) out[key] = String(n + amount);
  }
  return out;
}
