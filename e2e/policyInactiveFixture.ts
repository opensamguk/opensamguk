import type { PolicyWorld } from './policyFixture';

// T2-13 · AC-M2-17 미접속 사람 장수 화면 시나리오(policy-inactive.spec.ts)만 쓰는 fixture 행 다듬기와 읽기 도우미.
// 여기서 쓰는 값은 시험 조건을 만드는 fixture 데이터이고 제품 동작의 증거가 아니다.
// 쓰는 행은 이 시험이 만든 월드 안의 세 가지뿐이다. 자기 사람 장수(policyFixture의 장수 4) 한 행,
// 그 장수가 머무는 국가 1 수도(도시 1) 한 행, 같은 월드의 다른 장수들의 nextTurnTick이다.
// userId·defaultPolicy·lastActiveTick·lastActiveAt·InputEvent·GeneralLog·GeneralTurn·World 시계는 쓰지 않는다.

// 1440분 턴이면 한 달(10000 tick)이 월드 하루다. 활동 기준 0에서 140000 tick이 정확히 14일이다.
export const EXACT_FOURTEEN_DAYS_TICK = 140_000;
// 첫 실행 tick. 14일을 1 tick 넘긴다.
export const INACTIVE_DUE = 140_001;
// 그 뒤 자기 장수의 다음 두 턴. 직접 넣은 휴식과 예약 명령이 차례로 실행된다.
export const FOLLOW_REST_DUE = 150_001;
export const FOLLOW_RESERVED_DUE = 160_001;
// 다른 장수 턴을 시험 지평 밖으로 민다. NPC 명령·국가 명령·전투가 끼지 않게 한다.
export const PARKED_TURN = 10_000_000;
// 국가 1 수도. 월간 보급 계산이 늘 보급됨으로 둔다.
// policyFixture의 시작 도시 3은 국가 2 도시에만 이어져 첫 월간 정산부터 보급이 끊기므로 경계에서 이 도시로 옮긴다.
export const CAPITAL_CITY = 1;

type CityField =
  | 'agriculture'
  | 'agricultureMax'
  | 'commerce'
  | 'commerceMax'
  | 'security'
  | 'securityMax'
  | 'defence'
  | 'defenceMax'
  | 'wall'
  | 'wallMax';

export interface OwnShape {
  general: { gold: number; rice: number; injury: number; crew?: number; train?: number; atmos?: number };
  city: Partial<Record<CityField, number>>;
}

// 활동 기준(tick 0)을 확정한 뒤 한 번 부른다. 시계가 0이고 남은 입력이 없을 때만 쓴다.
export async function placeAtInactiveBoundary(world: PolicyWorld) {
  const db = world.hold.db;
  const clock = await db.world.findUniqueOrThrow({
    where: { id: world.id },
    select: { clockTick: true, status: true },
  });
  if (clock.clockTick !== 0 || clock.status !== 'RUNNING')
    throw new Error('미접속 경계는 시작 tick 0의 실행 중 월드에서만 만듭니다.');
  const pending = await db.inputEvent.count({ where: { worldId: world.id, status: 'PENDING' } });
  if (pending !== 0) throw new Error('미접속 경계는 남은 입력이 없을 때만 만듭니다.');
  const own = await db.general.updateMany({
    where: { worldId: world.id, id: world.generalId, userId: world.userId },
    data: { nextTurnTick: INACTIVE_DUE, cityKey: CAPITAL_CITY },
  });
  if (own.count !== 1) throw new Error('자기 사람 장수를 찾지 못했습니다.');
  const others = await db.general.updateMany({
    where: { worldId: world.id, id: { not: world.generalId } },
    data: { nextTurnTick: PARKED_TURN },
  });
  return {
    worldId: world.id,
    ownGeneral: { id: world.generalId, nextTurnTick: INACTIVE_DUE, cityKey: CAPITAL_CITY },
    parkedGenerals: others.count,
    parkedTurn: PARKED_TURN,
  };
}

// 자기 턴 직전에 기대 갈래가 성공할 자원과 최대치만 맞춘다. 월간 정산이 끝난 뒤, 그 턴의 tick 전에만 부른다.
export async function prepareOwnTurn(world: PolicyWorld, shape: OwnShape, dueTick: number) {
  const db = world.hold.db;
  const clock = await db.world.findUniqueOrThrow({ where: { id: world.id }, select: { clockTick: true } });
  if (clock.clockTick >= dueTick) throw new Error('자기 턴이 지난 뒤에는 자원을 맞추지 않습니다.');
  const own = await db.general.updateMany({
    where: { worldId: world.id, id: world.generalId, userId: world.userId, cityKey: CAPITAL_CITY },
    data: shape.general,
  });
  if (own.count !== 1) throw new Error('수도에 있는 자기 사람 장수를 찾지 못했습니다.');
  if (Object.keys(shape.city).length > 0)
    await db.city.update({
      where: { worldId_cityKey: { worldId: world.id, cityKey: CAPITAL_CITY } },
      data: shape.city,
    });
  return { worldId: world.id, generalId: world.generalId, cityKey: CAPITAL_CITY, before: dueTick, ...shape };
}

export function worldClock(world: PolicyWorld) {
  return world.hold.db.world.findUniqueOrThrow({
    where: { id: world.id },
    select: { clockTick: true, status: true, clockMode: true, turnTermMinutes: true },
  });
}

export function ownTurnState(world: PolicyWorld) {
  return world.hold.db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId: world.id, id: world.generalId } },
    select: {
      userId: true,
      defaultPolicy: true,
      lastActiveTick: true,
      nextTurnTick: true,
      nationId: true,
      officerLevel: true,
      cityKey: true,
      gold: true,
      crew: true,
      train: true,
      atmos: true,
      injury: true,
    },
  });
}

export function capitalCity(world: PolicyWorld) {
  return world.hold.db.city.findUniqueOrThrow({
    where: { worldId_cityKey: { worldId: world.id, cityKey: CAPITAL_CITY } },
    select: {
      nationId: true,
      supplied: true,
      agriculture: true,
      agricultureMax: true,
      commerce: true,
      commerceMax: true,
      security: true,
      securityMax: true,
      defence: true,
      defenceMax: true,
      wall: true,
      wallMax: true,
    },
  });
}

// 자기 장수의 한 tick 기록. 월드·장수·tick으로만 고른다.
export function ownLogAt(world: PolicyWorld, tick: number) {
  return world.hold.db.generalLog.findMany({
    where: { worldId: world.id, generalId: world.generalId, tick },
    select: { tick: true, commandKey: true, kind: true, text: true },
  });
}

// 이 월드의 입력 원장. 읽기만 한다.
export function inputLedger(world: PolicyWorld) {
  return world.hold.db.inputEvent.findMany({
    where: { worldId: world.id },
    orderBy: { id: 'asc' },
    select: { kind: true, status: true, generalId: true, result: true },
  });
}
