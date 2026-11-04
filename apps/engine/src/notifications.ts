import { enqueueNotifications, type NotificationEntry, type Prisma } from '@opensamguk/db';
import { canExecuteNationCommand, toGameDate, type WorldState, type runGeneralTurn } from '@opensamguk/rules';

type Tx = Prisma.TransactionClient;
type World = Pick<Prisma.WorldGetPayload<Record<string, never>>, 'id' | 'name' | 'startYear'>;
type Actor = Pick<Prisma.GeneralGetPayload<Record<string, never>>, 'id' | 'userId' | 'turnRevision'>;
type Outcome = ReturnType<typeof runGeneralTurn>['result'];
function displayText(value: string, limit: number) {
  if (value.length <= limit) return value;
  let result = '';
  for (const character of value) {
    if (result.length + character.length >= limit) break;
    result += character;
  }
  return result + '…';
}
function entry(
  world: World,
  userId: string,
  event: NotificationEntry['event'],
  tick: number,
  key: string,
  text: string,
): NotificationEntry {
  const date = toGameDate(world.startYear, tick);
  return {
    worldId: world.id,
    userId,
    event,
    dedupeKey: key,
    payload: {
      worldId: world.id,
      worldName: displayText(world.name, 200),
      year: date.year,
      month: date.month,
      text: displayText(text, 600),
    },
  };
}

// 점령·멸망 후 소속을 잃기 전에 수신자를 고른다. 저장은 호출한 턴의 CAS 뒤 같은 tx에서 한다.
export async function commandNotifications(
  tx: Tx,
  world: World,
  context: {
    actor: Actor;
    tick: number;
    before: WorldState;
    result: Outcome;
    national?: Outcome;
    modern: boolean;
    slots: readonly { slot: number; explicit: boolean }[];
  },
): Promise<NotificationEntry[]> {
  const { actor, tick, result, national, before, slots, modern } = context;
  const entries: NotificationEntry[] = [];
  if (actor.userId) {
    if ('code' in result || (national && 'code' in national))
      entries.push(
        entry(
          world,
          actor.userId,
          'turn.failed',
          tick,
          `turn-failed:${world.id}:${actor.id}:${tick}`,
          '예약한 명령을 실행하지 못했습니다.',
        ),
      );
    const count = slots.filter((slot) => slot.explicit).length;
    const remaining = slots.filter((slot) => slot.slot > 0 && slot.explicit).length;
    if (modern && count >= 4 && remaining <= 3)
      entries.push(
        entry(
          world,
          actor.userId,
          'turns.low',
          tick,
          `turns-low:${world.id}:${actor.id}:${actor.turnRevision + 1}`,
          `직접 예약한 예턴이 ${remaining}칸 남았습니다.`,
        ),
      );
  }
  const target = 'code' in result ? undefined : result.attackTarget;
  if (target) {
    const city = before.cities[target.cityKey];
    if (!city || city.nationId !== target.defendingNationId) throw Error('공격 전 대상 도시와 국가를 확인하세요.');
    if (target.defendingNationId !== null) {
      const members = await tx.general.findMany({
        where: { worldId: world.id, nationId: target.defendingNationId, userId: { not: null } },
        select: { userId: true },
        orderBy: { id: 'asc' },
      });
      for (const member of members)
        if (member.userId)
          entries.push(
            entry(
              world,
              member.userId,
              'attacked',
              tick,
              `attacked:${world.id}:${member.userId}:${tick}:${actor.id}`,
              `${displayText(city.name, 200)}에서 공격을 받았습니다.`,
            ),
          );
    }
  }
  return entries;
}

export async function enqueueTreatyOffer(tx: Tx, world: World, toNationId: number, treatyId: number, tick: number) {
  const members = await tx.general.findMany({
    where: { worldId: world.id, nationId: toNationId, userId: { not: null } },
    select: { userId: true, officerLevel: true },
    orderBy: { id: 'asc' },
  });
  return enqueueNotifications(
    tx,
    members.flatMap((member) =>
      member.userId && canExecuteNationCommand(member.officerLevel, 'nation_pact')
        ? [
            entry(
              world,
              member.userId,
              'diplomacy.offer',
              tick,
              `diplomacy-offer:${world.id}:${member.userId}:${treatyId}`,
              '새 외교 제안이 도착했습니다.',
            ),
          ]
        : [],
    ),
  );
}
