import { BALANCE, REPUTATION_POINTS } from '../balance';
import { toGameDate } from '../clock/clock';
import type { WorldView } from '../model/world';
import type { CommandResult, Failure } from '../commands/types';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import type { RecordedInput } from '../replay';
import { battleCancellation } from '../tactical/world';
import { battleStepSchema } from '../tactical/input';
import { reputationEventSchema, type ReputationEventRecord, type ReputationKind } from './schema';

function record(
  before: WorldView,
  generalId: number,
  tick: number,
  kind: ReputationKind,
  cityKey?: number,
): ReputationEventRecord {
  const general = before.generals[generalId];
  const nation = general?.nationId == null ? null : before.nations[general.nationId];
  const city = cityKey === undefined ? null : before.cities[cityKey];
  if (!general || nation === undefined || city === undefined) throw Error('평판 사건의 인물이나 공개 대상이 없습니다.');
  return reputationEventSchema.parse({
    generalId,
    ...toGameDate(before.startYear, tick),
    tick,
    kind,
    score: REPUTATION_POINTS[kind],
    data: {
      name: general.name,
      nation: nation === null ? null : { id: nation.id, name: nation.name, color: nation.color },
      city: city === null ? null : { cityKey: city.cityKey, name: city.name },
    },
  });
}

export function reputationTurnEvents(context: {
  before: WorldView;
  after: WorldView;
  generalId: number;
  tick: number;
  commandKey: string;
  result: CommandResult | Failure;
}): ReputationEventRecord[] {
  const { before, after, generalId, tick, commandKey, result } = context;
  if ('code' in result) return [];
  const events: ReputationEventRecord[] = [];
  const captures = result.battleAwards?.some((award) => award.generalId === generalId && award.captures > 0);
  if ((result.battleOutcomes?.length || captures) && !result.attackTarget)
    throw Error('평판 전투의 공개 도시가 없습니다.');
  for (const outcome of result.battleOutcomes ?? []) {
    if (outcome.winnerId === outcome.loserId) throw Error('평판 전투의 승자와 패자가 같습니다.');
    events.push(record(before, outcome.winnerId, tick, 'victory', result.attackTarget!.cityKey));
    events.push(record(before, outcome.loserId, tick, 'defeat', result.attackTarget!.cityKey));
  }
  const general = before.generals[generalId];
  if (!general) throw Error('평판 사건의 행동 장수가 없습니다.');
  if (captures && result.attackTarget) {
    const old = before.cities[result.attackTarget.cityKey],
      next = after.cities[result.attackTarget.cityKey];
    if (
      old &&
      next &&
      old.nationId !== next.nationId &&
      general.nationId !== null &&
      next.nationId === general.nationId
    )
      events.push(record(before, generalId, tick, 'conquest', old.cityKey));
  }
  const spec = DOMESTIC_SPECS.find((entry) => entry.key === commandKey);
  if (spec) {
    const city = before.cities[general.cityKey],
      nextCity = after.cities[general.cityKey];
    const nation = general.nationId === null ? undefined : before.nations[general.nationId];
    const nextNation = general.nationId === null ? undefined : after.nations[general.nationId];
    if (!city || !nextCity || !nation || !nextNation) throw Error('내정 평판의 대상이 없습니다.');
    const old = spec.field === 'tech' ? nation.tech : city[spec.field];
    const next = spec.field === 'tech' ? nextNation.tech : nextCity[spec.field];
    const max =
      spec.field === 'tech' ? BALANCE.MAX_TECH : spec.field === 'trust' ? BALANCE.MAX_TRUST : city[`${spec.field}Max`];
    if (old < max && next >= max) events.push(record(before, generalId, tick, 'domestic'));
  }
  const nextGeneral = after.generals[generalId];
  if (
    general.nationId !== null &&
    nextGeneral &&
    ((commandKey === 'resign' && nextGeneral.nationId === null) ||
      (commandKey === 'accept_invite' && nextGeneral.nationId !== null && nextGeneral.nationId !== general.nationId))
  )
    events.push(record(before, generalId, tick, 'betrayal'));
  return events;
}

export function reputationInputEvents(context: {
  before: WorldView;
  after?: WorldView;
  input: RecordedInput;
}): ReputationEventRecord[] {
  const { before, after, input } = context;
  if (input.status !== 'APPLIED') return [];
  if (input.kind === 'battle.step' && after) {
    if (input.tick == null) throw Error('전술 평판의 정산 시각이 없습니다.');
    const payload = battleStepSchema.parse(input.payload);
    return reputationBattleEvents(before, after, input.tick, payload.cancel ? payload.battleId : undefined);
  }
  if (input.kind !== 'treaty.break') return [];
  if (input.generalId === null || input.tick == null) throw Error('조약 파기 평판의 행위자나 시각이 없습니다.');
  return [record(before, input.generalId, input.tick, 'betrayal')];
}

export function reputationBattleEvents(
  before: WorldView,
  after: WorldView,
  tick: number,
  cancelledBattleId?: string,
): ReputationEventRecord[] {
  const events: ReputationEventRecord[] = [];
  for (const battle of after.campaign?.tactical?.battles ?? []) {
    const old = before.campaign?.tactical?.battles.find((row) => row.id === battle.id);
    if (!old || old.settled || !battle.settled || !battle.result) continue;
    if (battle.id === cancelledBattleId || battleCancellation(before, old) || battle.reason === '참가 국가 멸망')
      continue;
    const winner = battle.sides[battle.result].commanderId;
    const loser = battle.sides[battle.result === 'attack' ? 'defend' : 'attack'].commanderId;
    if (winner !== null && loser !== null) {
      events.push(record(before, winner, tick, 'victory', battle.targetCityKey));
      events.push(record(before, loser, tick, 'defeat', battle.targetCityKey));
    }
    if (
      battle.result === 'attack' &&
      winner !== null &&
      before.cities[battle.targetCityKey]?.nationId !== after.cities[battle.targetCityKey]?.nationId &&
      after.cities[battle.targetCityKey]?.nationId === battle.sides.attack.nationId
    )
      events.push(record(before, winner, tick, 'conquest', battle.targetCityKey));
  }
  return events;
}
