import type { WorldView } from '../model/world';
import { generalSexSchema } from '../general/sex';
import { LINEAGE_EXITED_YEAR } from './config';
import { heirEligibility, lineageAlive } from './eligibility';
import { readLineageState } from './state';

// 원본 참조는 퇴장 뒤에도 보존한다. 현재 조작권·재산·부곡은 퇴장한 장수에게 남기지 않는다.
export function assertLineageFinal(world: WorldView, tick: number): void {
  assertLineage(world, tick);
}

// 외부 입력 직후에는 후계자의 소속·조작권이 바뀔 수 있다. 참조와 퇴장 불변식은 즉시 검사한다.
export function assertLineageStorage(world: WorldView): void {
  assertLineage(world);
}

function assertLineage(world: WorldView, tick?: number): void {
  if (!world.lineage) return;
  const state = readLineageState(world.lineage);
  const generals = Object.values(world.generals);
  if (generals.length > state.config.limits.maxGenerals) throw new Error('가문 인원 상한을 넘었습니다.');
  const exists = (id: number) => {
    if (!world.generals[id]) throw new Error('존재하지 않는 장수를 참조합니다.');
  };
  const users = new Set<string>(),
    exited = new Set<number>();
  const incoming = new Map(generals.map((general) => [general.id, 0]));
  const children = new Map<number, number[]>();
  for (const [key, person] of Object.entries(state.persons)) {
    const id = Number(key);
    exists(id);
    for (const parent of person.parents) {
      exists(parent);
      const family = children.get(parent) ?? [];
      family.push(id);
      children.set(parent, family);
    }
    if (
      person.parents.length === 2 &&
      (world.generals[person.parents[0]]!.sex === 'UNKNOWN' ||
        world.generals[person.parents[1]]!.sex === 'UNKNOWN' ||
        world.generals[person.parents[0]]!.sex === world.generals[person.parents[1]]!.sex)
    )
      throw new Error('부모의 남녀 자료를 확인하세요.');
    incoming.set(id, person.parents.length);
    if (person.bornTick !== null && person.parents.length !== 2) throw new Error('태어난 장수의 부모 둘을 확인하세요.');
    if (person.successorId !== null) exists(person.successorId);
    if (person.exit?.cause === 'SUCCEEDED' && person.successorId === null)
      throw new Error('계승한 후계자를 확인하세요.');
    if (person.heirId !== null) {
      exists(person.heirId);
      if (person.exit || (tick !== undefined && heirEligibility(world, id, person.heirId, tick)))
        throw new Error('현재 후계자의 적격성을 확인하세요.');
    }
  }
  const roots = generals.filter((general) => incoming.get(general.id) === 0).map((general) => general.id);
  for (let index = 0; index < roots.length; index++) {
    for (const child of children.get(roots[index]!) ?? []) {
      const count = incoming.get(child)! - 1;
      incoming.set(child, count);
      if (count === 0) roots.push(child);
    }
  }
  if (roots.length !== generals.length) throw new Error('혈연은 순환할 수 없습니다.');
  for (const general of generals) {
    generalSexSchema.parse(general.sex);
    const exit = state.persons[String(general.id)]?.exit;
    if ((general.activeFromYear === LINEAGE_EXITED_YEAR) !== !!exit)
      throw new Error('퇴장 표지와 가문 기록이 다릅니다.');
    if (exit) {
      exited.add(general.id);
      if (
        general.userId !== null ||
        general.nationId !== null ||
        general.officerLevel !== 0 ||
        general.crew !== 0 ||
        general.gold !== 0 ||
        general.rice !== 0
      )
        throw new Error('퇴장한 장수에게 조작권·직위·재산을 남길 수 없습니다.');
    } else if (general.userId !== null) {
      if (users.has(general.userId)) throw new Error('사람의 조작 장수는 한 명이어야 합니다.');
      users.add(general.userId);
    }
  }
  for (const marriage of state.marriages) {
    exists(marriage.a);
    exists(marriage.b);
    if (!lineageAlive(world, marriage.a) || !lineageAlive(world, marriage.b))
      throw new Error('현재 혼인에 퇴장한 장수를 남길 수 없습니다.');
    if (
      world.generals[marriage.a]!.sex === 'UNKNOWN' ||
      world.generals[marriage.b]!.sex === 'UNKNOWN' ||
      world.generals[marriage.a]!.sex === world.generals[marriage.b]!.sex
    )
      throw new Error('현재 혼인의 남녀 자료를 확인하세요.');
  }
  for (const offer of state.offers) {
    exists(offer.fromId);
    exists(offer.toId);
    if (!lineageAlive(world, offer.fromId) || !lineageAlive(world, offer.toId))
      throw new Error('퇴장한 장수의 혼인 제안을 정리하세요.');
  }
  if (
    world.campaign?.units.some((unit) => exited.has(unit.ownerId) || exited.has(unit.commanderId)) ||
    world.campaign?.links.some((link) => exited.has(link.masterId) || exited.has(link.personId)) ||
    world.campaign?.offers.some(
      (offer) => offer.status === 'PENDING' && (exited.has(offer.masterId) || exited.has(offer.personId)),
    ) ||
    world.campaign?.orders?.items.some(
      (order) =>
        (order.status === 'PENDING' || order.status === 'READY') &&
        (exited.has(order.issuerId) || exited.has(order.recipientId)),
    )
  )
    throw new Error('퇴장한 장수의 부곡·휘하·제안을 정리하세요.');
}
