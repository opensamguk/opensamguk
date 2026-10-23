const noCommands = Object.freeze([] as const);
const personnelCommands = Object.freeze(['nation_rest', 'nation_reward', 'nation_seize', 'nation_assign'] as const);
const diplomaticCommands = Object.freeze([
  ...personnelCommands,
  'nation_peace',
  'nation_pact',
  'nation_break_pact',
  'nation_aid',
] as const);
const rulerCommands = Object.freeze([...diplomaticCommands, 'nation_declare', 'nation_capital'] as const);

export const OFFICER_ROLES = Object.freeze([
  Object.freeze({
    levels: Object.freeze([12] as const),
    title: '군주',
    managePersonnel: true,
    commands: rulerCommands,
  }),
  Object.freeze({
    levels: Object.freeze([11] as const),
    title: '참모',
    managePersonnel: false,
    commands: diplomaticCommands,
  }),
  Object.freeze({
    levels: Object.freeze([10, 9, 8, 7, 6, 5] as const),
    title: '수뇌',
    managePersonnel: false,
    commands: personnelCommands,
  }),
  Object.freeze({ levels: Object.freeze([1] as const), title: '장수', managePersonnel: false, commands: noCommands }),
  Object.freeze({ levels: Object.freeze([0] as const), title: '재야', managePersonnel: false, commands: noCommands }),
] as const);

export type OfficerRole = (typeof OFFICER_ROLES)[number];
export type OfficerLevel = OfficerRole['levels'][number];
export type NationCommandKey = OfficerRole['commands'][number];
export type AppointableOfficerLevel = Exclude<OfficerLevel, 0 | 1 | 12>;

const commandKeys = [...new Set(OFFICER_ROLES.flatMap<NationCommandKey>((role) => role.commands))];
export const NATION_COMMAND_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    commandKeys.map((key) => [
      key,
      Object.freeze(
        OFFICER_ROLES.filter((role) => role.commands.some((command) => command === key)).flatMap<OfficerLevel>(
          (role) => role.levels,
        ),
      ),
    ]),
  ),
) as Readonly<Record<NationCommandKey, readonly OfficerLevel[]>>;

export const APPOINTABLE_OFFICER_LEVELS = Object.freeze(
  OFFICER_ROLES.filter((role) => !role.managePersonnel && role.commands.length > 0).flatMap<OfficerLevel>(
    (role) => role.levels,
  ),
) as readonly AppointableOfficerLevel[];

export function officerRole(officerLevel: unknown): OfficerRole | null {
  if (typeof officerLevel !== 'number' || !Number.isInteger(officerLevel)) return null;
  return OFFICER_ROLES.find((role) => role.levels.some((level) => level === officerLevel)) ?? null;
}

export const officerTitle = (officerLevel: unknown) => officerRole(officerLevel)?.title ?? null;
export const canManagePersonnel = (officerLevel: unknown): boolean =>
  officerRole(officerLevel)?.managePersonnel === true;
export const canUseNationTurns = (officerLevel: unknown): boolean =>
  (officerRole(officerLevel)?.commands.length ?? 0) > 0;
export const nationCommandKeys = (officerLevel: unknown): readonly NationCommandKey[] =>
  officerRole(officerLevel)?.commands ?? noCommands;
export function isAppointableOfficerLevel(officerLevel: unknown): officerLevel is AppointableOfficerLevel {
  return typeof officerLevel === 'number' && APPOINTABLE_OFFICER_LEVELS.some((level) => level === officerLevel);
}

// 소속·행위자 검사는 호출부가 한다. 여기서는 직책 표만 판정한다.
export function canExecuteNationCommand(officerLevel: unknown, commandKey: unknown): boolean {
  if (typeof commandKey !== 'string' || !Object.hasOwn(NATION_COMMAND_PERMISSIONS, commandKey)) return false;
  const role = officerRole(officerLevel);
  if (!role) return false;
  return NATION_COMMAND_PERMISSIONS[commandKey as NationCommandKey].some((level) => level === officerLevel);
}
