import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import type { ClosedOffer, WorldState, WorldView } from '@opensamguk/rules';

type PendingOffer = NonNullable<WorldState['assignmentOffers']>[number];
type Descriptor = { targetGeneralId: number; offer: PendingOffer };
export type AssignmentSnapshot = Pick<WorldView, 'assignmentOffers'>;
export type AssignmentDelta = Readonly<{
  before: AssignmentSnapshot;
  beforeFinish: AssignmentSnapshot;
  final: AssignmentSnapshot;
  closedOffers: readonly ClosedOffer[];
}>;

const offerKeys = ['id', 'nationId', 'issuerGeneralId', 'cityKey', 'createdTick', 'expiresTick'];
const closedKeys = ['id', 'status', 'resolvedBy', 'cancelReason', 'resolvedTick'];
const maxInteger = 2_147_483_647;

function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('발령 제안의 필드가 올바르지 않습니다.');
}

function integer(value: unknown, minimum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maxInteger)
    throw new Error('발령 제안의 값이 정수 저장 범위와 맞지 않습니다.');
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('발령 제안 id가 올바르지 않습니다.');
}

function readOffer(value: unknown): PendingOffer {
  fields(value, offerKeys);
  const { id, nationId, issuerGeneralId, cityKey, createdTick, expiresTick } = value;
  identifier(id);
  integer(nationId, 1);
  integer(issuerGeneralId, 1);
  integer(cityKey, 1);
  integer(createdTick, 0);
  integer(expiresTick, 0);
  return { id, nationId, issuerGeneralId, cityKey, createdTick, expiresTick };
}

function descriptors(snapshot: AssignmentSnapshot): Map<string, Descriptor> {
  const offers = snapshot.assignmentOffers;
  const result = new Map<string, Descriptor>();
  if (offers === undefined) return result;
  if (!offers || typeof offers !== 'object' || Array.isArray(offers))
    throw new Error('발령 제안 목록이 올바르지 않습니다.');
  for (const key of Reflect.ownKeys(offers)) {
    const targetGeneralId = typeof key === 'string' ? Number(key) : NaN;
    integer(targetGeneralId, 1);
    if (String(targetGeneralId) !== key) throw new Error('발령 대상 키가 올바르지 않습니다.');
    const offer = readOffer(offers[targetGeneralId]);
    if (result.has(offer.id)) throw new Error('발령 제안 id가 중복됐습니다.');
    result.set(offer.id, { targetGeneralId, offer });
  }
  return result;
}

function readClosure(value: unknown): ClosedOffer {
  fields(value, closedKeys);
  const { id, status, resolvedBy, cancelReason, resolvedTick } = value;
  identifier(id);
  integer(resolvedTick, 0);
  if (status === 'ACCEPTED' && (resolvedBy === 'RESPONSE' || resolvedBy === 'EXPIRY') && cancelReason === null)
    return { id, status, resolvedBy, cancelReason, resolvedTick };
  if (status === 'REJECTED' && resolvedBy === 'RESPONSE' && cancelReason === null)
    return { id, status, resolvedBy, cancelReason, resolvedTick };
  if (status === 'SUPERSEDED' && resolvedBy === null && cancelReason === null)
    return { id, status, resolvedBy, cancelReason, resolvedTick };
  if (
    status === 'CANCELLED' &&
    resolvedBy === null &&
    (cancelReason === 'CITY_LOST' || cancelReason === 'TARGET_LEFT' || cancelReason === 'ISSUER_LOST_OFFICE')
  )
    return { id, status, resolvedBy, cancelReason, resolvedTick };
  throw new Error('발령 제안의 종료 상태 조합이 올바르지 않습니다.');
}

function ordered(values: Iterable<Descriptor>): Descriptor[] {
  return [...values].sort(
    (a, b) => a.targetGeneralId - b.targetGeneralId || (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0),
  );
}

export async function loadAssignmentState(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Pick<WorldState, 'assignmentOffers'>> {
  const rows = await tx.assignmentOffer.findMany({
    where: { worldId, status: 'PENDING' },
    orderBy: [{ targetGeneralId: 'asc' }, { id: 'asc' }],
  });
  const assignmentOffers: NonNullable<WorldState['assignmentOffers']> = {};
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      row.worldId !== worldId ||
      row.status !== 'PENDING' ||
      row.resolvedBy !== null ||
      row.cancelReason !== null ||
      row.resolvedTick !== null
    )
      throw new Error('저장된 발령 제안이 PENDING 상태와 다릅니다.');
    integer(row.targetGeneralId, 1);
    const offer = readOffer({
      id: row.id,
      nationId: row.nationId,
      issuerGeneralId: row.issuerGeneralId,
      cityKey: row.cityKey,
      createdTick: row.createdTick,
      expiresTick: row.expiresTick,
    });
    if (Object.hasOwn(assignmentOffers, row.targetGeneralId) || ids.has(offer.id))
      throw new Error('저장된 발령 대상 또는 제안 id가 중복됐습니다.');
    assignmentOffers[row.targetGeneralId] = offer;
    ids.add(offer.id);
  }
  return rows.length ? { assignmentOffers } : {};
}

// 호출자가 World 잠금과 리스 펜싱을 잡고 before를 적재한다. 오류는 전체 트랜잭션을 되돌려야 한다.
export async function persistAssignmentState(
  tx: Prisma.TransactionClient,
  worldId: string,
  delta: AssignmentDelta,
): Promise<void> {
  const before = descriptors(delta.before);
  const witness = descriptors(delta.beforeFinish);
  const final = descriptors(delta.final);
  const all = new Map(before);
  for (const [id, entry] of witness) {
    if (all.has(id) && !isDeepStrictEqual(all.get(id), entry)) throw new Error('발령 제안의 생성 정보가 바뀌었습니다.');
    all.set(id, entry);
  }
  for (const [id, entry] of final)
    if (!isDeepStrictEqual(witness.get(id), entry)) throw new Error('최종 발령 제안이 마무리 전 증인과 다릅니다.');

  if (!Array.isArray(delta.closedOffers)) throw new Error('발령 제안 종료 목록이 올바르지 않습니다.');
  const closed = new Map<string, ClosedOffer>();
  for (const value of delta.closedOffers) {
    const offer = readClosure(value);
    const original = all.get(offer.id);
    if (!original || final.has(offer.id) || closed.has(offer.id))
      throw new Error('발령 제안 종료 기록이 상태와 다릅니다.');
    if (offer.resolvedTick < original.offer.createdTick) throw new Error('발령 제안 종료 tick이 생성보다 이릅니다.');
    closed.set(offer.id, offer);
  }
  if (closed.size !== all.size - final.size) throw new Error('발령 제안 종료 기록이 빠졌습니다.');

  if (!isDeepStrictEqual(before, descriptors(await loadAssignmentState(tx, worldId))))
    throw new Error('저장된 발령 제안과 before가 다릅니다.');

  async function close(offer: ClosedOffer) {
    const { id, status, resolvedBy, cancelReason, resolvedTick } = offer;
    const saved = await tx.assignmentOffer.updateMany({
      where: { worldId, id, status: 'PENDING' },
      data: { status, resolvedBy, cancelReason, resolvedTick },
    });
    if (saved.count !== 1) throw new Error('발령 제안 종료가 한 행에 적용되지 않았습니다.');
  }

  const entries = ordered(all.values());
  for (const { offer } of entries) if (before.has(offer.id) && closed.has(offer.id)) await close(closed.get(offer.id)!);
  for (const { targetGeneralId, offer } of entries)
    if (!before.has(offer.id))
      await tx.assignmentOffer.create({ data: { worldId, targetGeneralId, ...offer, status: 'PENDING' } });
  for (const { offer } of entries)
    if (!before.has(offer.id) && closed.has(offer.id)) await close(closed.get(offer.id)!);
}
