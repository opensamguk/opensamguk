// 예턴 미리보기에 쓸 명령 이름. 서버 응답에는 commandKey만 있어 이름은 화면이 붙인다.
// 출처: packages/rules/src/commands의 name (eedd815, MVP 37개). 모르는 키는 키를 그대로 보여 준다.
const COMMAND_NAMES: Record<string, string> = {
  rest: '휴식',
  farm: '농지 개간',
  commerce: '상업 투자',
  security: '치안 강화',
  settle: '정착 장려',
  goodwill: '주민 선정',
  defence: '수비 강화',
  wall: '성벽 보수',
  research: '기술 연구',
  recruit: '모병',
  conscript: '징병',
  train: '훈련',
  morale: '사기진작',
  move: '이동',
  return: '귀환',
  dismiss: '소집해제',
  attack: '출병',
  found: '건국',
  uprising: '거병',
  join: '임관',
  join_random: '무작위 임관',
  resign: '하야',
  invite: '등용',
  accept_invite: '등용 수락',
  heal: '요양',
  trade_rice: '군량매매',
  donate: '헌납',
  nation_rest: '휴식',
  nation_reward: '포상',
  nation_seize: '몰수',
  nation_assign: '발령',
  nation_capital: '천도',
  nation_declare: '선전포고',
  nation_peace: '종전 제의',
  nation_pact: '불가침 제의',
  nation_break_pact: '불가침 파기 제의',
  nation_aid: '원조',
};

export const commandName = (key: string) => COMMAND_NAMES[key] ?? key;

// 직책. 규칙의 직책 표(packages/rules/src/personnel/permissions.ts)를 따른다: 12 군주, 11 참모, 5~10 수뇌, 1 일반, 0 재야.
// 시나리오 장수는 소속이 있어도 0으로 시작하므로, 소속이 있으면 0도 일반으로 본다. 표에 없는 2~4는 단계로 보여 준다.
export function officerName(level: number, hasNation = level !== 0): string {
  if (level === 12) return '군주';
  if (level === 11) return '참모';
  if (level >= 5 && level <= 10) return '수뇌';
  if (level === 1 || (level === 0 && hasNation)) return '일반';
  if (level === 0) return '재야';
  return `관직 ${level}단계`;
}

// 장수 이름 표시 (D-085). 괄호와 그 안을 뺀다. 조조(曹操) → 조조, 유도(145년생) → 유도.
export function displayName(name: string): string {
  const stripped = name.replace(/\s*[（(][^()（）]*[)）]\s*/g, '').trim();
  return stripped === '' ? name : stripped;
}
