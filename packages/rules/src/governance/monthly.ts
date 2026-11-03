import { CITY_RESOURCE_MAX, readCityResourcesState } from '../cityResources/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import { monthlyDate } from '../monthly';
import type { WorldView } from '../model/world';
import { GOVERNANCE_OFFICES } from './config';
import { assertGovernanceConserved, type GovernanceMovement } from './ledger';
import {
  ascendGovernanceNpc,
  proposeGovernanceNpcOffers,
  respondGovernanceNpcOffers,
  type GovernanceNpcAction,
} from './npc';
import { reconcileGovernance } from './reconcile';

export interface GovernancePayment {
  kind: 'TRIBUTE' | 'STIPEND';
  refId: number;
  resource: 'gold' | 'rice';
  want: number;
  paid: number;
  status: 'PAID' | 'TRUNCATED' | 'SKIPPED';
  reason: 'TRANSFER' | 'REMITTED' | 'NO_CAPITAL' | 'SEAT_SHORT' | 'HOLDER_FULL';
}

export function settleGovernanceMonthly(world: WorldView, tick: number) {
  if (!world.ruleFeatures?.includes('governance-v1') || !world.governance)
    throw new Error('황실 정산 상태가 없습니다.');
  if (tick !== world.governance.monthlyTick + TICKS_PER_MONTH)
    throw new Error('황실 월 정산이 중복되거나 달을 건너뛰었습니다.');
  const date = monthlyDate(world.startYear, tick);
  let state = reconcileGovernance(world, tick);
  const gov = state.governance!;
  if (gov.revision === CITY_RESOURCE_MAX) throw new Error('황실 변경 번호 한도에 닿았습니다.');
  state.cityResources = readCityResourcesState(state.cityResources, state);
  const snapshot = readCityResourcesState(world.cityResources, world);
  const movements: GovernanceMovement[] = [],
    payments: GovernancePayment[] = [],
    actions: GovernanceNpcAction[] = [];
  for (const id of gov.pendingRenounce) {
    const row = gov.vassals.find((entry) => entry.id === id);
    if (!row) continue;
    gov.legitimacy[String(row.vassalNationId)] = Math.max(
      0,
      gov.legitimacy[String(row.vassalNationId)]! - gov.config.legitimacy.renounceLoss,
    );
    gov.vassals = gov.vassals.filter((entry) => entry.id !== id);
  }
  gov.pendingRenounce = [];
  gov.monthlyTick = tick;
  state = reconcileGovernance(state, tick);
  const responses = respondGovernanceNpcOffers(state, tick);
  state = responses.state;
  actions.push(...responses.actions);
  const pair = (
    details: Pick<GovernanceMovement, 'kind' | 'refId' | 'resource' | 'fromNationId' | 'toNationId'>,
    from: number,
    to: number,
    amount: number,
    holder: 'city' | 'general',
  ) => {
    if (amount === 0) return;
    state.cityResources!.cities[String(from)]![details.resource] -= amount;
    if (holder === 'city') state.cityResources!.cities[String(to)]![details.resource] += amount;
    else state.generals[to]!.gold += amount;
    movements.push(
      { ...details, holder: 'city', holderId: from, delta: -amount },
      { ...details, holder, holderId: to, delta: amount },
    );
  };
  const resource = [1, 7].includes(date.month) ? 'gold' : [4, 10].includes(date.month) ? 'rice' : null;
  if (resource)
    for (const row of state.governance!.vassals) {
      const lower = state.nations[row.vassalNationId],
        upper = state.nations[row.overlordNationId];
      const from = lower?.capitalCityKey,
        to = upper?.capitalCityKey;
      const valid =
        from !== undefined &&
        to !== undefined &&
        state.cities[from]?.nationId === row.vassalNationId &&
        state.cities[to]?.nationId === row.overlordNationId;
      const bp = resource === 'gold' ? row.goldBp : row.riceBp;
      const want = valid ? Number((BigInt(snapshot.cities[String(from)]![resource]) * BigInt(bp)) / 10_000n) : 0;
      const capped = Math.min(want, state.governance!.config.tribute.maxAmount);
      const remitted = row.remitUntilTick > 0 && tick <= row.remitUntilTick;
      const paid =
        !valid || remitted
          ? 0
          : Math.min(
              capped,
              state.cityResources!.cities[String(from)]![resource],
              CITY_RESOURCE_MAX - state.cityResources!.cities[String(to)]![resource],
            );
      payments.push({
        kind: 'TRIBUTE',
        refId: row.id,
        resource,
        want: capped,
        paid,
        status: !valid || remitted ? 'SKIPPED' : paid < capped ? 'TRUNCATED' : 'PAID',
        reason: !valid ? 'NO_CAPITAL' : remitted ? 'REMITTED' : 'TRANSFER',
      });
      pair(
        {
          kind: 'TRIBUTE',
          refId: row.id,
          resource,
          fromNationId: row.vassalNationId,
          toNationId: row.overlordNationId,
        },
        from ?? 0,
        to ?? 0,
        paid,
        'city',
      );
    }
  const current = state.governance!,
    seat = current.config.seatCityKey;
  for (const [index, office] of GOVERNANCE_OFFICES.entries()) {
    const appointment = current.court[office];
    if (!appointment) continue;
    const holder = state.generals[appointment.generalId]!,
      amount = current.config.stipendGold[office];
    const reason =
      state.cityResources!.cities[String(seat)]!.gold < amount
        ? 'SEAT_SHORT'
        : holder.gold > CITY_RESOURCE_MAX - amount
          ? 'HOLDER_FULL'
          : 'TRANSFER';
    const paid = reason === 'TRANSFER' ? amount : 0;
    payments.push({
      kind: 'STIPEND',
      refId: index + 1,
      resource: 'gold',
      want: amount,
      paid,
      status: reason === 'TRANSFER' ? 'PAID' : 'SKIPPED',
      reason,
    });
    pair(
      {
        kind: 'STIPEND',
        refId: index + 1,
        resource: 'gold',
        fromNationId: current.throne.emperorNationId!,
        toNationId: holder.nationId!,
      },
      seat,
      holder.id,
      paid,
      'general',
    );
  }
  for (const key of Object.keys(current.legitimacy).sort((a, b) => Number(a) - Number(b))) {
    const id = Number(key),
      config = current.config.legitimacy;
    const offices = GOVERNANCE_OFFICES.filter((office) => {
      const holder = current.court[office];
      return holder && state.generals[holder.generalId]?.nationId === id;
    }).length;
    const gain =
      (state.cities[seat]?.nationId === id ? config.seatGain : 0) +
      (current.throne.emperorNationId === id ? config.emperorGain : 0) +
      Math.min(config.maxOfficeGain, offices * config.officeGain);
    current.legitimacy[key] = Math.min(100, Math.max(0, current.legitimacy[key]! + (gain || -config.decay)));
  }
  const ascended = ascendGovernanceNpc(state, tick);
  state = ascended.state;
  actions.push(...ascended.actions);
  const proposed = proposeGovernanceNpcOffers(state, tick);
  state = proposed.state;
  actions.push(...proposed.actions);
  state = reconcileGovernance(state, tick);
  if (state.governance!.revision === CITY_RESOURCE_MAX) throw new Error('황실 변경 번호 한도에 닿았습니다.');
  state.governance!.revision++;
  assertGovernanceConserved(world, state, movements);
  return { state, movements, payments, actions };
}
