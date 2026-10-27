import { publicGeographySchema } from '@opensamguk/shared';
import type { Prisma } from '@opensamguk/db';
import { BALANCE, type CampaignUnitState } from '@opensamguk/rules';
import { z } from 'zod';

type General = Omit<
  Prisma.GeneralGetPayload<true>,
  'battleWins' | 'captures' | 'noticeSeen' | 'defaultPolicy' | 'lastActiveTick' | 'lastActiveAt' | 'politics' | 'charm'
> & { politics?: number | null; charm?: number | null };
type City = Omit<Prisma.CityGetPayload<true>, 'kind'> & { kind?: string | null };
type Nation = Omit<Prisma.NationGetPayload<true>, 'notice' | 'noticeRevision' | 'noticeUpdatedAt' | 'noticeUpdatedBy'>;
export type Viewer = Pick<General, 'id' | 'nationId' | 'cityKey'> | null;

export function visibility(viewer: Viewer) {
  const sameNation = (nationId: number | null) =>
    viewer !== null && viewer.nationId !== null && viewer.nationId === nationId;
  return {
    city: (city: Pick<City, 'cityKey' | 'nationId'>) =>
      sameNation(city.nationId) || (viewer !== null && viewer.cityKey === city.cityKey),
    nation: (nation: Pick<Nation, 'id'>) => sameNation(nation.id),
    general: (general: Pick<General, 'id' | 'nationId'>) =>
      viewer !== null && (viewer.id === general.id || sameNation(general.nationId)),
  };
}

export function mapCity(city: City) {
  return {
    key: city.cityKey,
    ...(city.kind != null ? { kind: city.kind } : {}),
    name: city.name,
    level: city.level,
    x: city.x,
    y: city.y,
    nationId: city.nationId,
    supplied: city.supplied,
    links: city.connections,
  };
}

export function ownGeneralInfo(general: General) {
  return {
    id: general.id,
    name: general.name,
    nationId: general.nationId,
    portraitId: general.portraitId,
    cityKey: general.cityKey,
    leadership: general.leadership,
    strength: general.strength,
    intel: general.intel,
    ...(general.politics != null && general.charm != null ? { politics: general.politics, charm: general.charm } : {}),
    officerLevel: general.officerLevel,
    birthYear: general.birthYear,
    deathYear: general.deathYear,
    activeFromYear: general.activeFromYear,
    personality: general.personality,
    special: general.special,
    gold: general.gold,
    rice: general.rice,
    crew: general.crew,
    crewType: general.crewType,
    train: general.train,
    atmos: general.atmos,
    experience: general.experience,
    dedication: general.dedication,
    age: general.age,
    injury: general.injury,
    nextTurnTick: general.nextTurnTick,
  };
}

export function generalInfo(general: General, viewer: Viewer) {
  return visibility(viewer).general(general)
    ? ownGeneralInfo(general)
    : { id: general.id, name: general.name, nationId: general.nationId };
}

// 병력은 부곡에만 저장한다. 주둔 표는 실제 지휘관별 병력과 병력 가중 평균을 읽는다.
export function garrisonGeneralInfo(general: General, viewer: Viewer, units?: readonly CampaignUnitState[]) {
  if (!visibility(viewer).general(general)) return { id: general.id, name: general.name, nationId: general.nationId };
  const detail = ownGeneralInfo(general);
  if (units === undefined) return detail;
  let troops = 0,
    train = 0,
    atmos = 0;
  for (const unit of units) {
    if (unit.commanderId !== general.id) continue;
    troops += unit.troops;
    train += unit.train * unit.troops;
    atmos += unit.atmos * unit.troops;
  }
  return {
    ...detail,
    commandedArmy: {
      troops,
      train: troops === 0 ? 0 : Math.floor(train / troops),
      atmos: troops === 0 ? 0 : Math.floor(atmos / troops),
    },
  };
}

export function cityInfo(city: City, viewer: Viewer) {
  const publicInfo = mapCity(city);
  if (!visibility(viewer).city(city)) return publicInfo;
  return {
    ...publicInfo,
    region: city.region,
    population: city.population,
    populationMax: city.populationMax,
    agriculture: city.agriculture,
    agricultureMax: city.agricultureMax,
    commerce: city.commerce,
    commerceMax: city.commerceMax,
    security: city.security,
    securityMax: city.securityMax,
    defence: city.defence,
    defenceMax: city.defenceMax,
    wall: city.wall,
    wallMax: city.wallMax,
    trust: city.trust,
  };
}

export function nationInfo(nation: Nation, counts: { cityCount: number; generalCount: number }, viewer: Viewer) {
  const publicInfo = { id: nation.id, name: nation.name, color: nation.color, ...counts };
  if (!visibility(viewer).nation(nation)) return publicInfo;
  return {
    ...publicInfo,
    description: nation.description,
    tech: nation.tech,
    philosophy: nation.philosophy,
    level: nation.level,
    capitalCityKey: nation.capitalCityKey,
    gold: nation.gold,
    rice: nation.rice,
    taxRate: BALANCE.MONTHLY_TAX_RATE,
  };
}

export const logSelect = {
  id: true,
  tick: true,
  commandKey: true,
  kind: true,
  text: true,
} as const satisfies Prisma.GeneralLogSelect;
export function logInfo(log: Prisma.GeneralLogGetPayload<{ select: typeof logSelect }>) {
  return { id: log.id.toString(), tick: log.tick, commandKey: log.commandKey, kind: log.kind, text: log.text };
}

// 월간 JSON은 저장 형태를 그대로 반환하지 않는다. 공개 허용 필드만 파싱한다.
const publicNationSummary = z.object({
  nationId: z.number().int(),
  cities: z.number().int(),
  generals: z.number().int(),
});
const memberNationSummary = publicNationSummary.extend({ gold: z.number().int(), rice: z.number().int() });
const publicYearbook = z.object({
  nations: z.array(publicNationSummary),
  cities: z.array(z.object({ cityKey: z.number().int(), nationId: z.number().int().nullable() })),
});
export const worldRecordInfo = (data: Prisma.JsonValue) => publicYearbook.parse(data);
export const nationRecordInfo = (data: Prisma.JsonValue) => memberNationSummary.parse(data);

const timelapseYearbook = z.object({
  cities: z.array(z.object({ cityKey: z.number().int(), nationId: z.number().int().nullable() })),
});
export const timelapseFrameInfo = (data: Prisma.JsonValue) => ({
  cities: [...timelapseYearbook.parse(data).cities].sort((a, b) => a.cityKey - b.cityKey),
});
export const publicNationDisplaySelect = {
  id: true,
  name: true,
  color: true,
} as const satisfies Prisma.NationSelect;

export const publicTimelapseCitySelect = {
  cityKey: true,
  name: true,
  x: true,
  y: true,
  connections: true,
} as const satisfies Prisma.CitySelect;

export function publicTimelapseCityInfo(city: Prisma.CityGetPayload<{ select: typeof publicTimelapseCitySelect }>) {
  return { cityKey: city.cityKey, name: city.name, x: city.x, y: city.y, connections: city.connections };
}

const publicMapData = z.object({
  operationalMap: publicGeographySchema.optional(),
  cities: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      level: z.number().int(),
      kind: z.enum(['CITY', 'PASS']).optional(),
      x: z.number(),
      y: z.number(),
      nationId: z.number().int().nullable(),
      links: z.array(z.string()),
    }),
  ),
  nations: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string() })),
});

// 오염되거나 형식이 깨진 사본은 현재 상태로 대체하지 않는다.
export function publicMapInfo(data: Prisma.JsonValue) {
  const result = publicMapData.safeParse(data);
  return result.success ? result.data : null;
}
