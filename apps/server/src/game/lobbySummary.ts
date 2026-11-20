import { creationBlock, HUMAN_GENERAL_LIMIT, statRulesSchema, type effectiveWorldOptions } from '@opensamguk/rules';

type Options = ReturnType<typeof effectiveWorldOptions>;

export function lobbyEntry(
  world: { status: 'RUNNING' | 'PREOPEN' | 'PAUSED' | 'ENDED'; replayFormat: number },
  options: Options,
  humans: number,
  npcs: number,
): Array<'create' | 'possess'> {
  const modes: Array<'create' | 'possess'> = [];
  if (
    !creationBlock({
      status: world.status,
      hasGeneral: false,
      hasPending: false,
      humanCount: humans,
      entryOpen: options.entry.generalCreation === 'open',
    })
  )
    modes.push('create');
  if (
    world.replayFormat === 3 &&
    ['PREOPEN', 'RUNNING'].includes(world.status) &&
    options.entry.npcPlay === 'on' &&
    humans < HUMAN_GENERAL_LIMIT &&
    npcs > 0
  )
    modes.push('possess');
  return modes;
}

export function lobbySettings(
  features: readonly string[],
  options: Options,
  stats: unknown,
  fiction: number | undefined,
): Array<{ name: string; value: string }> {
  const stat = statRulesSchema.parse({ stat: stats }).stat;
  const time = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return [
    { name: '시나리오 모드', value: fiction === 0 ? '역사' : fiction === 1 ? '가상' : '미지정' },
    { name: '능력치', value: `${5}종 · 기본 총합 ${stat.total}` },
    { name: 'NPC 공격성', value: options.presetRules ? String(options.presetRules.npc.aggression) : '기본' },
    { name: 'NPC 장수 맡기', value: options.entry.npcPlay === 'on' ? '허용' : '닫힘' },
    { name: '장수 생성', value: options.entry.generalCreation === 'open' ? '허용' : '닫힘' },
    { name: '모집 범위', value: options.recruitmentLocation === 'territory' ? '영지' : '도시' },
    {
      name: '야간 휴전',
      value: options.truce
        ? `${time(options.truce.startMinute)}~${time(options.truce.endMinute)} (UTC${options.truce.utcOffsetMinutes >= 0 ? '+' : ''}${options.truce.utcOffsetMinutes / 60})`
        : '없음',
    },
  ];
}
