import type { ResidenceAnchors } from './npcMonth';
import type { OfficeView } from './offices';
import { PersonnelInvariantError } from './types';

export type ResidenceStepInput = Readonly<{
  before: OfficeView;
  after: OfficeView;
  anchors: ResidenceAnchors;
  tick: number;
  createdHumanId: number | null;
  succession?: Readonly<{ fromId: number; toId: number }> | undefined;
  possession?: Readonly<{ generalId: number; userId: string }> | undefined;
}>;

function storedTick(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

// 생성·실제 이동·검증한 계승/맡기 출처만 기록한다. tick 순서로 기존 앵커를 보정하지 않는다.
export function updateResidenceAnchors(input: ResidenceStepInput): Record<number, number> {
  const { before, after, anchors, tick, createdHumanId, succession, possession } = input;
  if (!storedTick(tick)) throw new PersonnelInvariantError('물리 거주 앵커의 처리 tick이 잘못됐습니다.');
  const peopleBefore = Object.values(before.generals).filter((general) => general.userId !== null);
  if (Object.keys(anchors).length !== peopleBefore.length)
    throw new PersonnelInvariantError('물리 거주 앵커와 시작 상태의 사람 장수가 다릅니다.');
  for (const key of Object.keys(anchors)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== key || before.generals[id]?.userId == null)
      throw new PersonnelInvariantError('물리 거주 앵커의 장수가 잘못됐습니다.');
    if (!storedTick(anchors[id])) throw new PersonnelInvariantError('저장된 물리 거주 앵커가 잘못됐습니다.');
  }
  for (const general of peopleBefore)
    if (!Object.hasOwn(anchors, general.id))
      throw new PersonnelInvariantError('사람 장수의 물리 거주 앵커가 없습니다.');

  if (
    createdHumanId !== null &&
    (!Number.isSafeInteger(createdHumanId) ||
      createdHumanId < 1 ||
      before.generals[createdHumanId] !== undefined ||
      after.generals[createdHumanId]?.userId == null)
  )
    throw new PersonnelInvariantError('실제 생성한 사람 장수의 출처가 잘못됐습니다.');

  const next: Record<number, number> = {};
  if (possession) {
    const { generalId, userId } = possession;
    const source = before.generals[generalId],
      target = after.generals[generalId];
    if (
      createdHumanId !== null ||
      succession !== undefined ||
      !Number.isSafeInteger(generalId) ||
      generalId < 1 ||
      typeof userId !== 'string' ||
      userId.length === 0 ||
      source?.userId !== null ||
      target?.userId !== userId ||
      source.cityKey !== target.cityKey ||
      peopleBefore.some((person) => person.userId === userId)
    )
      throw new PersonnelInvariantError('장수 맡기의 거주 앵커 출처가 잘못됐습니다.');
  }
  if (succession) {
    const { fromId, toId } = succession;
    const source = before.generals[fromId],
      target = before.generals[toId];
    const record = after.lineage?.persons[String(fromId)];
    if (
      !after.ruleFeatures?.includes('lineage-v1') ||
      createdHumanId !== null ||
      !Number.isSafeInteger(fromId) ||
      !Number.isSafeInteger(toId) ||
      fromId < 1 ||
      toId < 1 ||
      fromId === toId ||
      !source?.userId ||
      target?.userId !== null ||
      after.generals[fromId]?.userId !== null ||
      after.generals[toId]?.userId !== source.userId ||
      record?.exit?.cause !== 'SUCCEEDED' ||
      record.successorId !== toId
    )
      throw new PersonnelInvariantError('사람 계승의 거주 앵커 출처가 잘못됐습니다.');
  }
  const people = Object.values(after.generals)
    .filter((general) => general.userId !== null)
    .sort((a, b) => a.id - b.id);
  for (const general of people) {
    const previous = before.generals[general.id];
    if (!previous) {
      if (general.id !== createdHumanId)
        throw new PersonnelInvariantError('생성 출처가 없는 사람 장수의 앵커를 만들 수 없습니다.');
      next[general.id] = tick;
      continue;
    }
    if (previous.userId === null && (general.id === succession?.toId || general.id === possession?.generalId)) {
      next[general.id] = tick;
      continue;
    }
    if (previous.userId === null)
      throw new PersonnelInvariantError('NPC 장수를 사람으로 바꾼 물리 앵커를 추정할 수 없습니다.');
    const anchor = anchors[general.id]!;
    if (previous.cityKey === general.cityKey) next[general.id] = anchor;
    else next[general.id] = tick;
  }
  return next;
}
