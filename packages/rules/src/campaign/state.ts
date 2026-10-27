import { z } from 'zod';
import type { WorldView } from '../model/world';
import { FIVE_STAT_KEYS, fiveStatsSchema } from '../general/fiveStats';
import { buildRetinueHierarchy, INITIAL_RENOWN_CAPACITY, type RetinuePerson } from './retinue';

const integer = z.number().int().min(0).max(2_147_483_647);
const id = integer.min(1);
export const retinueRelationSchema = z.enum(['STAFF', 'LIEUTENANT', 'GUEST']);
export const campaignUnitSchema = z.strictObject({
  id,
  ownerId: id,
  commanderId: id,
  troops: integer,
  crewType: id,
  train: integer.max(100),
  atmos: integer.max(100),
});
export const campaignOfferSchema = z.strictObject({
  id,
  masterId: id,
  personId: id,
  relation: retinueRelationSchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED']),
  createdTick: integer,
});
export const campaignStateSchema = z.strictObject({
  version: z.literal(1),
  seed: z.string().min(1),
  revision: integer,
  nextUnitId: id,
  nextOfferId: id,
  sources: z.record(z.string(), z.string().min(1)),
  links: z.array(z.strictObject({ masterId: id, personId: id, relation: retinueRelationSchema })),
  offers: z.array(campaignOfferSchema),
  units: z.array(campaignUnitSchema),
  attempts: z.array(z.strictObject({ masterId: id, personId: id, month: integer })),
});
export type CampaignState = z.infer<typeof campaignStateSchema>;
export type CampaignUnitState = z.infer<typeof campaignUnitSchema>;

// sources는 검증한 생성 기록이나 general.create 입력을 가리킨다. 능력치를 보간하지 않는다.
export function campaignPeople(world: WorldView, campaign: Readonly<CampaignState>): RetinuePerson[] {
  return Object.values(world.generals).map((general) => ({
    id: general.id,
    worldId: 'campaign-v1',
    nationId: general.nationId,
    stats: {
      ...fiveStatsSchema.parse(Object.fromEntries(FIVE_STAT_KEYS.map((key) => [key, general[key]]))),
      source: campaign.sources[String(general.id)] ?? '',
    },
  }));
}

// DB와 재생에서 같은 상태를 검사하며 잘못된 관계를 빈 목록으로 읽지 않는다.
export function readCampaignState(value: unknown, world: WorldView, expectedSeed?: string): CampaignState {
  const state = campaignStateSchema.parse(value);
  if (expectedSeed !== undefined && state.seed !== expectedSeed) throw new Error('휘하 상태와 월드 시드가 다릅니다.');
  const people = campaignPeople(world, state);
  if (
    Object.keys(state.sources).length !== people.length ||
    Object.keys(state.sources).some((key) => !world.generals[Number(key)] || String(Number(key)) !== key)
  )
    throw new Error('휘하 인물의 생성 출처 대응이 다릅니다.');
  const tree = buildRetinueHierarchy(people, state.links);
  for (const person of people)
    if (!tree.withinCapacity(person.id, INITIAL_RENOWN_CAPACITY)) throw new Error('휘하 명망 수용량을 넘었습니다.');
  if (
    new Set(state.units.map((unit) => unit.id)).size !== state.units.length ||
    new Set(state.offers.map((offer) => offer.id)).size !== state.offers.length ||
    state.units.some((unit) => unit.id >= state.nextUnitId) ||
    state.offers.some((offer) => offer.id >= state.nextOfferId)
  )
    throw new Error('휘하·부곡 번호가 중복되거나 다음 번호를 넘었습니다.');
  for (const unit of state.units) {
    const owner = world.generals[unit.ownerId],
      commander = world.generals[unit.commanderId];
    if (
      !owner ||
      !commander ||
      owner.nationId !== commander.nationId ||
      (owner.id !== commander.id &&
        (commander.userId !== null ||
          !state.links.some(
            (link) => link.masterId === owner.id && link.personId === commander.id && link.relation === 'LIEUTENANT',
          )))
    )
      throw new Error('부곡 소유자와 실제 지휘관의 관계가 다릅니다.');
  }
  for (const person of people) {
    let commanded = 0;
    for (const unit of state.units.filter((unit) => unit.commanderId === person.id)) {
      if (unit.troops > person.stats.leadership * 100 - commanded)
        throw new Error('실제 지휘관의 병력 상한을 넘었습니다.');
      commanded += unit.troops;
    }
  }
  const pairs = new Set<string>();
  for (const attempt of state.attempts) {
    const pair = `${attempt.masterId}:${attempt.personId}`;
    if (!world.generals[attempt.masterId] || !world.generals[attempt.personId] || pairs.has(pair))
      throw new Error('NPC 서약의 월별 시도 원장이 다릅니다.');
    pairs.add(pair);
  }
  for (const offer of state.offers)
    if (!world.generals[offer.masterId] || !world.generals[offer.personId] || offer.masterId === offer.personId)
      throw new Error('휘하 제안의 인물 참조가 다릅니다.');
  return state;
}

export function emptyCampaignState(world: WorldView, seed: string, scenarioKey: string): CampaignState {
  return readCampaignState(
    {
      version: 1,
      seed,
      revision: 0,
      nextUnitId: 1,
      nextOfferId: 1,
      sources: Object.fromEntries(
        Object.values(world.generals).map((general) => [
          String(general.id),
          `scenario:${scenarioKey}#general:${general.id}`,
        ]),
      ),
      links: [],
      offers: [],
      units: [],
      attempts: [],
    },
    world,
    seed,
  );
}
