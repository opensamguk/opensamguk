import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { toGameDate } from '../clock/clock';
import type { WorldState, WorldView } from '../model/world';
import { hasCitySecretary, localOfficeTitle } from './residentOffice';

export const CITY_OFFICE_VOLUNTEER_FEATURE = 'city-office-volunteer-v1';
export const initialCityOfficeVolunteers = (): CityOfficeVolunteerState => ({
  requests: {},
  appointments: {},
  joined: {},
});
export const cityOfficeLevel = z.union([z.literal(2), z.literal(3), z.literal(4)]);
const id = z.number().int().positive().max(2_147_483_647);
const tickValue = z.number().int().nonnegative().max(2_147_483_647);
const status = z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'cancelled']);
const row = z.strictObject({
  generalId: id,
  userId: z.string().min(1),
  nationId: id,
  cityKey: id,
  officerLevel: cityOfficeLevel,
  incumbentId: id.nullable(),
  quarter: tickValue,
  createdTick: tickValue,
  dueTick: tickValue,
  defaultDecision: z.enum(['approve', 'reject']),
  defaultReason: z.enum(['secret', 'vacant', 'npc', 'absent']),
  status,
  resultReason: z.string().nullable(),
});
export const cityOfficeVolunteerState = z.strictObject({
  requests: z.record(z.string(), row),
  appointments: z.record(z.string(), tickValue),
  joined: z.record(z.string(), tickValue),
});
export type CityOfficeVolunteerState = z.infer<typeof cityOfficeVolunteerState>;
export type CityOfficeVolunteer = z.infer<typeof row>;
type Level = z.infer<typeof cityOfficeLevel>;
type RequestView = Readonly<CityOfficeVolunteer>;
const quarterAt = (tick: number) => Math.floor(tick / (3 * TICKS_PER_MONTH));
const position = (cityKey: number, level: Level) => cityKey + ':' + level;

function incumbent(world: WorldView, cityKey: number, level: Level) {
  return Object.values(world.generals).find(
    (general) =>
      general.removedAt === undefined && general.officerCityKey === cityKey && general.officerLevel === level,
  );
}

export function cityOfficeVolunteerEligibility(world: WorldView, generalId: number, level: Level, tick: number) {
  const general = world.generals[generalId];
  const city = general && world.cities[general.cityKey];
  const current = city && incumbent(world, city.cityKey, level);
  const request = world.cityOfficeVolunteers?.requests[generalId];
  const confidentialYears =
    general?.nationId == null ? undefined : world.nations[general.nationId]?.restrictions?.confidentialYears;
  const secret =
    Math.floor((tick - (world.cityOfficeVolunteers?.joined[generalId] ?? tick)) / (12 * TICKS_PER_MONTH)) <
    (confidentialYears ?? 3);
  const defaultReason = secret ? 'secret' : !current ? 'vacant' : current.userId === null ? 'npc' : 'absent';
  const defaultDecision = defaultReason === 'vacant' || defaultReason === 'npc' ? 'approve' : 'reject';
  let reason: string | null = null;
  if (!world.officeEffects || (level === 2 && !hasCitySecretary(world.officeEffects)))
    reason = '이 관직을 사용할 수 없습니다.';
  else if (!general || !city || city.kind === 'PASS' || general.nationId === null || city.nationId !== general.nationId)
    reason = '체류 중인 자기 국가 도시에서만 자원할 수 있습니다.';
  else if (
    general.userId === null ||
    general.removedAt !== undefined ||
    general.activeFromYear > toGameDate(world.startYear, tick).year ||
    general.officerLevel < 1 ||
    general.officerLevel >= 5
  )
    reason = '일반·도시 관직 장수만 자원할 수 있습니다.';
  else if (world.cityOfficeVolunteers?.appointments[position(city.cityKey, level)] === quarterAt(tick))
    reason = '이번 분기에 이미 임명한 자리입니다.';
  else if (level !== 2 && (level === 4 ? general.strength : general.intel) < world.officeEffects.minimumAbility)
    reason = level === 4 ? '무력이 부족합니다.' : '지력이 부족합니다.';
  else if (current?.id === general.id) reason = '현재 재직 중입니다.';
  else if (current?.userId && current.cityKey === city.cityKey) reason = '재직자가 도시에 체류 중입니다.';
  return {
    reason,
    defaultReason,
    defaultDecision,
    incumbentId: current?.id ?? null,
    requestedThisQuarter: request?.quarter === quarterAt(tick),
  } as const;
}

export function readCityOfficeVolunteers(features: readonly string[], value: unknown) {
  if (features.includes(CITY_OFFICE_VOLUNTEER_FEATURE)) return cityOfficeVolunteerState.parse(value);
  if (value != null) throw new Error('도시 관직 자원을 끈 월드에 저장 상태가 있습니다.');
  return undefined;
}

export function syncCityOfficeVolunteers(before: WorldView, state: WorldState, tick: number) {
  const volunteers = state.cityOfficeVolunteers;
  if (!volunteers) return;
  for (const general of Object.values(state.generals)) {
    const prior = before.generals[general.id];
    if (general.userId === null || general.nationId === null || general.removedAt !== undefined)
      delete volunteers.joined[general.id];
    else if (prior?.userId !== general.userId || prior.nationId !== general.nationId)
      volunteers.joined[general.id] = tick;
    if (general.officerCityKey == null || general.officerLevel < 2 || general.officerLevel > 4) continue;
    if (prior?.officerCityKey !== general.officerCityKey || prior.officerLevel !== general.officerLevel)
      volunteers.appointments[position(general.officerCityKey, cityOfficeLevel.parse(general.officerLevel))] =
        quarterAt(tick);
  }
  for (const [key, quarter] of Object.entries(volunteers.appointments)) {
    if (quarter < quarterAt(tick)) delete volunteers.appointments[key];
  }
}

export const cityOfficeVolunteerAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('request'), officerLevel: cityOfficeLevel }),
  z.strictObject({ action: z.enum(['approve', 'reject', 'withdraw']), generalId: id, quarter: tickValue }),
]);
export const cityOfficeVolunteerResult = z.strictObject({ tick: tickValue, generalId: id, quarter: tickValue, status });
export type CityOfficeVolunteerAction = z.infer<typeof cityOfficeVolunteerAction>;

function invalidReason(world: WorldView, request: RequestView, tick: number) {
  const general = world.generals[request.generalId];
  if (!general || general.userId !== request.userId || general.nationId !== request.nationId)
    return '소속 또는 장수 소유자가 바뀌었습니다.';
  if (general.cityKey !== request.cityKey) return '체류 도시가 바뀌었습니다.';
  const check = cityOfficeVolunteerEligibility(world, request.generalId, request.officerLevel, tick);
  return check.incumbentId !== request.incumbentId ? '재직자가 바뀌었습니다.' : check.reason;
}

function decide(
  state: WorldState,
  request: CityOfficeVolunteer,
  next: CityOfficeVolunteer['status'],
  reason: string,
  tick: number,
) {
  if (next === 'approved') {
    const old = request.incumbentId === null ? undefined : state.generals[request.incumbentId];
    if (old) {
      old.officerLevel = 1;
      delete old.officerCityKey;
    }
    const general = state.generals[request.generalId]!;
    general.officerLevel = request.officerLevel;
    general.officerCityKey = request.cityKey;
    state.cityOfficeVolunteers!.appointments[position(request.cityKey, request.officerLevel)] = quarterAt(tick);
  }
  request.status = next;
  request.resultReason = reason;
}

export function settleCityOfficeVolunteers(state: WorldState, tick: number, expire = true) {
  for (const request of Object.values(state.cityOfficeVolunteers?.requests ?? {})) {
    if (request.status !== 'pending') continue;
    const reason = invalidReason(state, request, tick);
    if (reason) decide(state, request, 'cancelled', reason, tick);
    else if (expire && tick >= request.dueTick) {
      const automatic =
        request.defaultDecision === 'approve' &&
        cityOfficeVolunteerEligibility(state, request.generalId, request.officerLevel, tick).defaultDecision ===
          'approve';
      decide(
        state,
        request,
        automatic ? 'approved' : 'rejected',
        automatic ? '기한 만료로 자동 임명' : '기한 만료로 자동 거부',
        tick,
      );
    }
  }
}

export function actOnCityOfficeVolunteer(
  view: WorldView,
  actorId: number,
  input: CityOfficeVolunteerAction,
  tick: number,
) {
  const failure = (message: string) => ({ ok: false as const, message });
  if (!view.cityOfficeVolunteers) return failure('도시 관직 자원을 사용할 수 없습니다.');
  const actor = view.generals[actorId];
  if (!actor || actor.userId === null || actor.nationId === null || actor.removedAt !== undefined)
    return failure('국가에 소속된 장수만 처리할 수 있습니다.');
  const state = structuredClone(view) as WorldState;
  settleCityOfficeVolunteers(state, tick);
  const requests = state.cityOfficeVolunteers!.requests;
  if (input.action === 'request') {
    const previous = requests[actorId];
    const quarter = quarterAt(tick);
    if (previous?.status === 'pending' || previous?.quarter === quarter)
      return failure('이번 분기에 이미 자원했습니다.');
    const check = cityOfficeVolunteerEligibility(state, actorId, input.officerLevel, tick);
    if (check.reason) return failure(check.reason);
    if (
      Object.values(requests).some(
        (request) =>
          request.status === 'pending' &&
          request.cityKey === actor.cityKey &&
          request.officerLevel === input.officerLevel,
      )
    )
      return failure('이미 다른 장수가 자원한 관직입니다.');
    const dueTick = (Math.ceil(tick / TICKS_PER_MONTH) + 1) * TICKS_PER_MONTH;
    if (!tickValue.safeParse(dueTick).success) return failure('요청 기한이 월드 시간 한도를 넘습니다.');
    const request: CityOfficeVolunteer = {
      generalId: actor.id,
      userId: actor.userId,
      nationId: actor.nationId,
      cityKey: actor.cityKey,
      officerLevel: input.officerLevel,
      incumbentId: check.incumbentId,
      quarter,
      createdTick: tick,
      dueTick,
      defaultDecision: check.defaultDecision,
      defaultReason: check.defaultReason,
      status: 'pending',
      resultReason: null,
    };
    requests[actorId] = request;
    return { ok: true as const, state, request };
  }
  const request = requests[input.generalId];
  if (
    !request ||
    request.status !== 'pending' ||
    request.nationId !== actor.nationId ||
    request.quarter !== input.quarter
  )
    return failure('이미 처리했거나 찾을 수 없는 요청입니다.');
  if (input.action === 'withdraw') {
    if (request.generalId !== actorId) return failure('본인의 요청만 철회할 수 있습니다.');
    decide(state, request, 'withdrawn', '본인 철회', tick);
  } else {
    if (actor.officerLevel < 5) return failure('수뇌부만 요청을 처리할 수 있습니다.');
    if (input.action === 'approve') decide(state, request, 'approved', '수뇌부 임명', tick);
    else decide(state, request, 'rejected', '수뇌부 거부', tick);
  }
  return { ok: true as const, state, request };
}

export function cityOfficeVolunteerInfo(world: WorldView, request: RequestView) {
  return {
    generalId: request.generalId,
    nationId: request.nationId,
    cityKey: request.cityKey,
    officerLevel: request.officerLevel,
    quarter: request.quarter,
    createdTick: request.createdTick,
    dueTick: request.dueTick,
    defaultDecision: request.defaultDecision,
    defaultReason: request.defaultReason,
    status: request.status,
    resultReason: request.resultReason,
    generalName: world.generals[request.generalId]?.name ?? null,
    cityName: world.cities[request.cityKey]?.name ?? null,
    title: localOfficeTitle(request.officerLevel),
  };
}
