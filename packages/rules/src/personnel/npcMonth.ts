import { TICKS_PER_MONTH } from '../clock/constants';
import type { DeepReadonly } from '../model/world';
import { monthlyDate } from '../monthly/index';
import { assignGeneral } from './assignments';
import type { OfficeState, OfficeView } from './offices';
import type { PersonnelRawStep } from './step';
import { PersonnelInvariantError } from './types';

export type ResidenceAnchors = DeepReadonly<Record<number, number>>;
export type NpcPersonnelHistory = Readonly<{ nationId: number; text: string }>;
export type NpcPersonnelDecision =
  | Readonly<{
      kind: 'assign';
      nationId: number;
      generalId: number;
      fromCityKey: number;
      cityKey: number;
      anchorTick: number;
    }>
  | Readonly<{ kind: 'reward'; nationId: number; generalId: number; gold: 1000 }>;
export type NpcPersonnelInput = Readonly<{
  before: OfficeView;
  anchors: ResidenceAnchors;
  raw: PersonnelRawStep;
  tick: number;
}>;
export type NpcPersonnelResult = Readonly<{
  raw: PersonnelRawStep;
  history: readonly NpcPersonnelHistory[];
  decisions: readonly NpcPersonnelDecision[];
}>;
export const NPC_PERSONNEL_MONTHS = [1, 4, 7, 10] as const;
export const NPC_RESIDENCE_TICKS = 6 * TICKS_PER_MONTH;
export const NPC_REWARD_THRESHOLD_GOLD = 10_000;
export const NPC_REWARD_MAX_RECIPIENTS = 3;
export const NPC_REWARD_GOLD = 1_000;

// M1의 전선 판정과 같다. 타국과 무주 도시를 모두 센다.
function frontier(view: OfficeView, nationId: number, cityKey: number): boolean {
  return view.cities[cityKey]!.connections.some((key) => view.cities[key]?.nationId !== nationId);
}

function nearestFrontier(view: OfficeView, nationId: number, start: number): number | undefined {
  const seen = new Set([start]);
  let layer = [start];
  while (layer.length) {
    const target = layer.filter((key) => frontier(view, nationId, key)).sort((a, b) => a - b)[0];
    if (target !== undefined) return target;
    const next: number[] = [];
    for (const key of layer) {
      for (const neighbor of view.cities[key]!.connections) {
        if (seen.has(neighbor) || view.cities[neighbor]?.nationId !== nationId) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    layer = next;
  }
  return undefined;
}

function effectiveAnchor(input: NpcPersonnelInput, generalId: number): number {
  const previous = input.before.generals[generalId];
  if (!previous) throw new PersonnelInvariantError('월간 인사 대상의 시작 상태가 없습니다.');
  const current = input.raw.state.generals[generalId]!;
  if (previous.cityKey !== current.cityKey) return input.tick;
  const anchor = input.anchors[generalId];
  if (!Number.isSafeInteger(anchor) || anchor === undefined || anchor < 0 || anchor > input.tick)
    throw new PersonnelInvariantError('사람 장수의 물리 거주 앵커가 잘못됐습니다.');
  return anchor;
}

// P3 raw 뒤에 붙이며 마무리와 앵커 저장은 caller가 한 번 수행한다.
export function runNpcPersonnelMonth(input: NpcPersonnelInput): NpcPersonnelResult {
  const { tick, before } = input;
  const date = monthlyDate(before.startYear, tick);
  if (before.startYear !== input.raw.state.startYear)
    throw new PersonnelInvariantError('월간 인사 시작 연도가 서로 다릅니다.');
  let state = structuredClone(input.raw.state) as OfficeState;
  const offices = structuredClone(input.raw.offices);
  const closedOffers = [...structuredClone(input.raw.closedOffers)];
  const logs = [...structuredClone(input.raw.logs)];
  const history: NpcPersonnelHistory[] = [];
  const decisions: NpcPersonnelDecision[] = [];
  const result = (): NpcPersonnelResult => ({ raw: { state, offices, closedOffers, logs }, history, decisions });
  if (!NPC_PERSONNEL_MONTHS.some((month) => month === date.month)) return result();

  const nationIds = Object.values(state.nations)
    .map((nation) => nation.id)
    .sort((a, b) => a - b);
  for (const nationId of nationIds) {
    if (!state.nations[nationId]!.isNpc) continue;
    const rulers = Object.values(state.generals).filter(
      (general) => general.nationId === nationId && general.officerLevel === 12,
    );
    if (rulers.length > 1) throw new PersonnelInvariantError('한 국가에 군주가 둘 이상 있습니다.');
    const ruler = rulers[0];
    if (!ruler || ruler.userId !== null) continue;
    const people = Object.values(state.generals)
      .filter((general) => general.nationId === nationId && general.userId !== null)
      .sort((a, b) => a.id - b.id);
    const anchors = new Map(people.map((general) => [general.id, effectiveAnchor(input, general.id)]));
    const appeared = people.filter((general) => general.activeFromYear <= date.year);
    const candidates = appeared
      .filter(
        (general) =>
          !state.assignmentOffers?.[general.id] &&
          state.cities[general.cityKey]?.nationId === nationId &&
          !frontier(state, nationId, general.cityKey) &&
          tick - anchors.get(general.id)! > NPC_RESIDENCE_TICKS,
      )
      .sort((a, b) => anchors.get(a.id)! - anchors.get(b.id)! || a.id - b.id);

    for (const general of candidates) {
      const cityKey = nearestFrontier(state, nationId, general.cityKey);
      if (cityKey === undefined) continue;
      // N1: 이번 step에 만든 제안을 다시 바꾸지 않는다.
      const current = state.assignmentOffers?.[general.id];
      if (current && before.assignmentOffers?.[general.id]?.id !== current.id)
        throw new PersonnelInvariantError('같은 step에서 발령 제안을 두 번 만들 수 없습니다.');
      const assigned = assignGeneral(state, ruler.id, general.id, cityKey, tick);
      if (!assigned.ok) throw new PersonnelInvariantError(`NPC 발령 조건이 맞지 않습니다: ${assigned.code}`);
      state = assigned.state;
      logs.push(...assigned.logs);
      closedOffers.push(...assigned.closedOffers);
      decisions.push({
        kind: 'assign',
        nationId,
        generalId: general.id,
        fromCityKey: general.cityKey,
        cityKey,
        anchorTick: anchors.get(general.id)!,
      });
      history.push({
        nationId,
        text: `${general.name}의 ${state.cities[cityKey]!.name} 발령을 제안했습니다. 같은 도시에 6개월 넘게 머물렀고 현재 후방에 있습니다.`,
      });
      break;
    }

    const nation = state.nations[nationId]!;
    if (nation.gold < NPC_REWARD_THRESHOLD_GOLD) continue;
    const recipients = [...appeared]
      .sort((a, b) => b.dedication - a.dedication || a.id - b.id)
      .slice(0, NPC_REWARD_MAX_RECIPIENTS);
    for (const recipient of recipients) {
      if (nation.gold < NPC_REWARD_GOLD) throw new PersonnelInvariantError('NPC 포상 국고가 부족합니다.');
      const general = state.generals[recipient.id]!;
      nation.gold -= NPC_REWARD_GOLD;
      general.gold += NPC_REWARD_GOLD;
      decisions.push({ kind: 'reward', nationId, generalId: general.id, gold: NPC_REWARD_GOLD });
      history.push({ nationId, text: `${general.name}에게 공헌 순위에 따라 금 1000을 포상했습니다.` });
    }
  }
  return result();
}
