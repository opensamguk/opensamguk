import { isDeepStrictEqual } from 'node:util';
import { assertStorableJson, type Prisma } from '@opensamguk/db';
import type { DeepReadonly, OfficeRevisions, OfficeState, OfficeTurns, OfficeView } from '@opensamguk/rules';

type OfficeSnapshot = Pick<OfficeView, 'officeTurns'> & { offices: DeepReadonly<OfficeRevisions> };
type Entry<T> = { nationId: number; officerLevel: number; value: T };
const maxInteger = 2_147_483_647;

function integer(value: number, min: number, max = maxInteger): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function entries<T>(records: Readonly<Record<number, Readonly<Record<number, T>>>> | undefined): Map<string, Entry<T>> {
  const result = new Map<string, Entry<T>>();
  for (const [nationKey, offices] of Object.entries(records ?? {})) {
    const nationId = Number(nationKey);
    if (String(nationId) !== nationKey || !integer(nationId, 1)) throw new Error('직책의 국가 번호를 확인하세요.');
    for (const [officeKey, value] of Object.entries(offices)) {
      const officerLevel = Number(officeKey);
      if (String(officerLevel) !== officeKey || !integer(officerLevel, 5, 12))
        throw new Error('직책 번호를 확인하세요.');
      result.set(`${nationId}:${officerLevel}`, { nationId, officerLevel, value });
    }
  }
  return result;
}

function validate(snapshot: OfficeSnapshot) {
  assertStorableJson(snapshot.offices, 'offices');
  if (snapshot.officeTurns !== undefined) assertStorableJson(snapshot.officeTurns, 'officeTurns');
  const offices = entries(snapshot.offices);
  const queues = entries(snapshot.officeTurns);
  for (const { value } of offices.values()) {
    if (Object.keys(value).length !== 2 || !integer(value.revision, 0) || !integer(value.tenure, 0))
      throw new Error('직책 revision과 tenure를 확인하세요.');
  }
  for (const { value: turns } of queues.values()) {
    if (!Array.isArray(turns) || turns.length !== 12) throw new Error('직책 예턴은 12칸이어야 합니다.');
    for (const turn of turns) {
      if (
        turn === null ||
        typeof turn !== 'object' ||
        Object.keys(turn).length !== 2 ||
        typeof turn.commandKey !== 'string' ||
        !Object.hasOwn(turn, 'args')
      )
        throw new Error('직책 예턴의 명령과 인자를 확인하세요.');
    }
  }
  return { offices, queues };
}

// 인사 기능을 끈 월드에서 호출한다. 발령 제안 등 나머지 표 검사는 호출자의 몫이다.
export async function assertNoOfficeRows(tx: Prisma.TransactionClient, worldId: string): Promise<void> {
  const [office, turn] = await Promise.all([
    tx.nationOffice.findFirst({ where: { worldId }, select: { nationId: true } }),
    tx.nationOfficeTurn.findFirst({ where: { worldId }, select: { nationId: true } }),
  ]);
  if (office || turn) throw new Error('인사 기능을 끈 월드에 직책 저장 행이 있습니다.');
}

// 기능 선택을 마친 호출자가 같은 트랜잭션에서 네 표의 저장 경계를 대조한다.
export async function assertPersonnelStorage(
  tx: Prisma.TransactionClient,
  worldId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    const legacy = await tx.nationTurn.findFirst({ where: { worldId }, select: { nationId: true } });
    if (legacy) throw new Error('인사 기능을 켠 월드에 기존 국가 예턴이 있습니다.');
    return;
  }
  const rows = await tx.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "NationOffice" WHERE "worldId" = ${worldId}
      UNION ALL SELECT 1 FROM "NationOfficeTurn" WHERE "worldId" = ${worldId}
      UNION ALL SELECT 1 FROM "AssignmentOffer" WHERE "worldId" = ${worldId}
    ) AS present
  `;
  if (rows.length !== 1 || rows[0]!.present !== false)
    throw new Error('인사 기능을 끈 월드에 인사 저장 행이 있습니다.');
}

export async function loadOfficeState(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Pick<OfficeState, 'officeTurns'> & { offices: OfficeRevisions }> {
  const [officeRows, turnRows] = await Promise.all([
    tx.nationOffice.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }] }),
    tx.nationOfficeTurn.findMany({
      where: { worldId },
      orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }, { slot: 'asc' }],
    }),
  ]);
  const offices: OfficeRevisions = {};
  const officeTurns: OfficeTurns = {};
  for (const row of officeRows) {
    (offices[row.nationId] ??= {})[row.officerLevel] = { revision: row.turnRevision, tenure: row.tenure };
  }
  for (const row of turnRows) {
    if (!integer(row.slot, 0, 11)) throw new Error('저장된 직책 예턴의 칸 번호를 확인하세요.');
    const nation = (officeTurns[row.nationId] ??= {});
    const queue = (nation[row.officerLevel] ??= Array.from({ length: 12 }, () => ({
      commandKey: 'nation_rest',
      args: {},
    })));
    queue[row.slot] = { commandKey: row.commandKey, args: structuredClone(row.args) };
  }
  const result = { offices, ...(turnRows.length ? { officeTurns } : {}) };
  validate(result);
  return result;
}

// 호출자가 같은 World 잠금·펜싱 트랜잭션에서 읽은 before와 규칙 실행 뒤 next를 넘긴다.
// 직책 칸 소비의 FOR UPDATE 잠금과 revision 증가는 호출자가 맡는다.
export async function persistOfficeState(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: OfficeSnapshot,
  next: OfficeSnapshot,
): Promise<void> {
  const original = validate(before);
  const final = validate(next);
  const keys = new Set([
    ...original.offices.keys(),
    ...final.offices.keys(),
    ...original.queues.keys(),
    ...final.queues.keys(),
  ]);
  for (const key of [...keys].sort()) {
    const oldOffice = original.offices.get(key);
    const newOffice = final.offices.get(key);
    const oldQueue = original.queues.get(key);
    const newQueue = final.queues.get(key);
    const queueChanged = !isDeepStrictEqual(oldQueue?.value, newQueue?.value);
    if (!queueChanged && isDeepStrictEqual(oldOffice?.value, newOffice?.value)) continue;
    const { nationId, officerLevel } = (newOffice ?? oldOffice ?? newQueue ?? oldQueue)!;
    if (oldOffice) {
      const where = {
        worldId,
        nationId,
        officerLevel,
        turnRevision: oldOffice.value.revision,
        tenure: oldOffice.value.tenure,
      };
      const changed = newOffice
        ? await tx.nationOffice.updateMany({
            where,
            data: { turnRevision: newOffice.value.revision, tenure: newOffice.value.tenure },
          })
        : await tx.nationOffice.deleteMany({ where });
      if (changed.count !== 1) throw new Error('저장할 직책의 revision 또는 tenure가 바뀌었습니다.');
    } else if (newOffice) {
      await tx.nationOffice.create({
        data: {
          worldId,
          nationId,
          officerLevel,
          turnRevision: newOffice.value.revision,
          tenure: newOffice.value.tenure,
        },
      });
    }
    if (!queueChanged) continue;
    await tx.nationOfficeTurn.deleteMany({ where: { worldId, nationId, officerLevel } });
    if (newQueue) {
      // 바인딩한 JSON으로 JSON null도 보존한다. 규칙 타입을 Prisma JSON 타입으로 강제 변환하지 않는다.
      const count = await tx.$executeRaw`
        INSERT INTO "NationOfficeTurn" ("worldId", "nationId", "officerLevel", "slot", "commandKey", "args")
        SELECT ${worldId}, ${nationId}, ${officerLevel}, (item.ordinality - 1)::integer,
          item.value->>'commandKey', item.value->'args'
        FROM jsonb_array_elements(${JSON.stringify(newQueue.value)}::jsonb) WITH ORDINALITY AS item(value, ordinality)
      `;
      if (count !== 12) throw new Error('직책 예턴 12칸을 저장하지 못했습니다.');
    }
  }
}
