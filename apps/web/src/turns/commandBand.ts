// 직위별 명령 띠 (D-099, 사용자 2026-11-15 "ui는 이 삼국지 7 같은걸로 ... 아래의 명령 선택 줄. 이거 플레이 유저의 직위마다 다르게 나오거든.").
// 명령을 세력 명령 일곱 묶음(인사·외교·군사·내정·계략·첩보·임면)과 개인 명령 네 묶음(재산·교우·처신·휴양)으로 나누고,
// 직위마다 띠에 보이는 묶음을 정한다. 서버가 실행할 수 있다고 한 명령은 직위 묶음 밖이어도 숨기지 않는다.

export type BandRole = 'ruler' | 'chief' | 'governor' | 'officer' | 'free';

export type BandGroupKey =
  | 'personnel'
  | 'diplomacy'
  | 'military'
  | 'domestic'
  | 'scheme'
  | 'intel'
  | 'appoint'
  | 'wealth'
  | 'friends'
  | 'conduct'
  | 'rest';

/** realm: 세력 명령(붉은 패), appoint: 임면(금색 패), self: 개인 명령(보라 패). */
export type BandSide = 'realm' | 'appoint' | 'self';

export const BAND_GROUPS: ReadonlyArray<{ key: BandGroupKey; label: string; side: BandSide }> = [
  { key: 'personnel', label: '인사', side: 'realm' },
  { key: 'diplomacy', label: '외교', side: 'realm' },
  { key: 'military', label: '군사', side: 'realm' },
  { key: 'domestic', label: '내정', side: 'realm' },
  { key: 'scheme', label: '계략', side: 'realm' },
  { key: 'intel', label: '첩보', side: 'realm' },
  { key: 'appoint', label: '임면', side: 'appoint' },
  { key: 'wealth', label: '재산', side: 'self' },
  { key: 'friends', label: '교우', side: 'self' },
  { key: 'conduct', label: '처신', side: 'self' },
  { key: 'rest', label: '휴양', side: 'self' },
];

export const ROLE_LABEL: Record<BandRole, string> = {
  ruler: '군주',
  chief: '수뇌',
  governor: '태수',
  officer: '일반',
  free: '재야',
};

/** 직위: 군주 12, 수뇌 5~11, 도시 관직(태수·군사·종사) 2~4, 일반 1, 국가가 없으면 재야. */
export function bandRole(general: { nationId: number | null; officerLevel: number } | null | undefined): BandRole {
  if (!general || general.nationId === null) return 'free';
  if (general.officerLevel >= 12) return 'ruler';
  if (general.officerLevel >= 5) return 'chief';
  if (general.officerLevel >= 2) return 'governor';
  return 'officer';
}

const SELF: BandGroupKey[] = ['wealth', 'friends', 'conduct', 'rest'];
const ROLE_GROUPS: Record<BandRole, readonly BandGroupKey[]> = {
  ruler: BAND_GROUPS.map((group) => group.key),
  chief: ['personnel', 'diplomacy', 'military', 'domestic', 'scheme', 'intel', ...SELF],
  governor: ['personnel', 'military', 'domestic', 'scheme', 'intel', ...SELF],
  officer: ['personnel', 'military', 'domestic', 'scheme', 'intel', ...SELF],
  free: ['intel', ...SELF],
};

export function roleGroups(role: BandRole): readonly BandGroupKey[] {
  return ROLE_GROUPS[role];
}

// 명령 키 → 묶음. 키가 표에 없으면 서버 분류(category)로 정한다.
const GROUP_OF: Record<string, BandGroupKey> = {
  invite: 'personnel',
  move: 'personnel',
  return: 'personnel',
  return_border: 'personnel',
  nation_declare: 'diplomacy',
  nation_peace: 'diplomacy',
  nation_pact: 'diplomacy',
  nation_break_pact: 'diplomacy',
  nation_aid: 'diplomacy',
  recruit: 'military',
  conscript: 'military',
  train: 'military',
  morale: 'military',
  attack: 'military',
  dismiss: 'military',
  nation_city_allocate: 'military',
  farm: 'domestic',
  commerce: 'domestic',
  security: 'domestic',
  settle: 'domestic',
  goodwill: 'domestic',
  defence: 'domestic',
  wall: 'domestic',
  research: 'domestic',
  trade: 'domestic',
  nation_capital: 'domestic',
  fire_attack: 'scheme',
  sabotage: 'scheme',
  incite: 'scheme',
  plunder: 'scheme',
  nation_mobilize: 'scheme',
  nation_rivalry: 'scheme',
  nation_raid: 'scheme',
  spy: 'intel',
  nation_assign: 'appoint',
  nation_reward: 'appoint',
  nation_seize: 'appoint',
  trade_rice: 'wealth',
  equipment_trade: 'wealth',
  donate: 'wealth',
  gift: 'friends',
  join: 'conduct',
  join_random: 'conduct',
  join_general: 'conduct',
  found: 'conduct',
  uprising: 'conduct',
  resign: 'conduct',
  accept_invite: 'conduct',
  abdicate: 'conduct',
  wander: 'conduct',
  resettle: 'conduct',
  disband: 'conduct',
  retire: 'conduct',
  rest: 'rest',
  heal: 'rest',
  nation_rest: 'rest',
};

const GROUP_OF_CATEGORY: Record<string, BandGroupKey> = {
  domestic: 'domestic',
  military: 'military',
  strategy: 'scheme',
  personal: 'conduct',
};

/** 묶음 키. 표에도 서버 분류에도 없는 명령은 서버 분류 이름 그대로 따로 묶는다. */
export function bandGroupOf(command: { key: string; category: string }): string {
  if (command.key.startsWith('nation_research_')) return 'military';
  return GROUP_OF[command.key] ?? GROUP_OF_CATEGORY[command.category] ?? command.category;
}

export type BandGroup<T> = { key: string; label: string; side: BandSide | 'other'; items: T[] };

/**
 * 띠에 그릴 묶음. 직위 묶음은 명령이 있을 때만, 직위 밖 묶음은 서버가 실행할 수 있다고 한 명령(available !== false)이 있을 때만 보인다.
 * 순서는 세력 명령 → 임면 → 개인 명령, 모르는 묶음은 맨 뒤다.
 */
export function bandGroups<T extends { key: string; category: string; available?: boolean | null | undefined }>(
  commands: readonly T[],
  role: BandRole,
  labelOf: (category: string) => string = (category) => category,
): BandGroup<T>[] {
  const allowed = new Set<string>(roleGroups(role));
  const byGroup = new Map<string, T[]>();
  for (const command of commands) {
    const key = bandGroupOf(command);
    const list = byGroup.get(key) ?? [];
    list.push(command);
    byGroup.set(key, list);
  }
  const known: BandGroup<T>[] = BAND_GROUPS.flatMap((group) => {
    const all = byGroup.get(group.key) ?? [];
    const items = allowed.has(group.key) ? all : all.filter((command) => command.available !== false);
    return items.length > 0 ? [{ key: group.key, label: group.label, side: group.side, items }] : [];
  });
  const knownKeys = new Set<string>(BAND_GROUPS.map((group) => group.key));
  const other: BandGroup<T>[] = [...byGroup.entries()]
    .filter(([key]) => !knownKeys.has(key))
    .map(([key, items]) => ({ key, label: labelOf(key), side: 'other' as const, items }));
  return [...known, ...other];
}

/** 직위·면에 맞는 명령 패 그림의 승인 경로(이미지 저장소, D-099). 재야에는 임면 패가 없어 세력 패를 쓴다. */
export function plaqueSource(role: BandRole, side: BandSide | 'all' | 'other'): string | null {
  if (side === 'all' || side === 'other') return null;
  const face = role === 'free' && side === 'appoint' ? 'realm' : side;
  return `apps/web/src/art/band/plaques/${role}-${face}.webp`;
}

// Codex가 그린 글자 그림 (int29-labels, 사용자 2026-11-15 "텍스트론 안되겠다. 코덱스로 뽑아.", "패 글자랑 메뉴는 생성한걸 써야지").
// 묶음 패와 직위 칸은 세로 글자(group-, role-), 세부 명령은 가로 글자(cmd-)다. 이름이 같은 명령은 같은 글자를 쓴다.
const LETTERING_ALIAS: Readonly<Record<string, string>> = { nation_rest: 'rest' };
export function letteringSource(kind: 'group' | 'role' | 'cmd', key: string): string {
  const name = kind === 'cmd' ? (LETTERING_ALIAS[key] ?? key) : key;
  return `apps/web/src/art/band/labels/${kind}-${name}.webp`;
}
