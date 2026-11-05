import type { Prisma, RealtimeSignal } from '@opensamguk/db';
import { toGameDate, type AdminGameAction, type AdminGameApplied, type WorldState } from '@opensamguk/rules';
import type { EngineWorld } from '../features';

const fields: Record<string, string> = {
  gold: '금',
  rice: '쌀',
  cityKey: '도시',
  crew: '병력',
  crewType: '병종',
  train: '훈련',
  atmos: '사기',
  population: '주민',
  agriculture: '농업',
  commerce: '상업',
  security: '치안',
  defence: '수비',
  wall: '성벽',
  trust: '민심',
  tech: '기술',
};
function summary(action: AdminGameAction, result: AdminGameApplied): string {
  switch (action.kind) {
    case 'admin.general.rename':
    case 'admin.nation.rename':
      return `이름을 ${action.name}(으)로 변경`;
    case 'admin.general.release':
      return 'NPC로 맡김';
    case 'admin.general.remove':
      return '월드에서 내보냄';
    case 'admin.general.clearTurns':
      return '예약 명령 30칸을 휴식으로 변경';
    case 'admin.nation.dismissOffice':
      return `장수 #${action.generalId} 수뇌 임명 취소`;
    case 'admin.message.send':
      return action.body;
    default: {
      const before = result.before as Record<string, number>,
        after = result.after as Record<string, number>;
      return Object.keys(after)
        .map((field) => `${fields[field]} ${before[field]} → ${after[field]}`)
        .join(', ');
    }
  }
}

// 사유와 운영 계정은 감사에만 남기고 게임에는 적용한 변경만 기록한다.
export async function persistAdminRecord(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  before: WorldState,
  action: AdminGameAction,
  result: AdminGameApplied,
  sequence: number,
  now: Date,
): Promise<RealtimeSignal | null> {
  const text = summary(action, result);
  if (action.kind.startsWith('admin.general.') && 'generalId' in action && action.generalId !== undefined) {
    const last = await tx.generalLog.findFirst({
      where: { worldId: world.id, generalId: action.generalId, sequence },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });
    await tx.generalLog.create({
      data: {
        worldId: world.id,
        generalId: action.generalId,
        tick: world.clockTick,
        sequence,
        ordinal: (last?.ordinal ?? -1) + 1,
        commandKey: action.kind,
        kind: 'admin',
        text,
      },
    });
    return null;
  }
  const privateMessage = action.kind === 'admin.message.send' && action.scope === 'PRIVATE';
  const target = privateMessage ? before.generals[action.generalId!]! : undefined;
  const nation = target?.nationId == null ? null : before.nations[target.nationId]!;
  const date = toGameDate(world.startYear, world.clockTick);
  const label =
    'cityKey' in action
      ? `도시 ${before.cities[action.cityKey]!.name}`
      : 'nationId' in action
        ? `국가 ${before.nations[action.nationId]!.name}`
        : '';
  await tx.message.create({
    data: {
      worldId: world.id,
      scope: privateMessage ? 'PRIVATE' : 'WORLD',
      fromParty: { kind: 'admin', name: '운영' },
      ...(target
        ? {
            recipientId: target.id,
            toParty: {
              generalId: target.id,
              name: target.name,
              nation: nation ? { id: nation.id, name: nation.name, color: nation.color } : null,
            },
          }
        : {}),
      body: label ? `${label}: ${text}` : text,
      sentAt: now,
      year: date.year,
      month: date.month,
    },
  });
  return privateMessage
    ? { kind: 'message.new', scope: 'PRIVATE', target: { generalId: target!.id } }
    : { kind: 'message.new', scope: 'WORLD', target: 'world' };
}
