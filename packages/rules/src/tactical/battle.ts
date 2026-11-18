import {
  rngFor,
  type BattleSide,
  type BattleAction,
  type BattlePlan,
  type TacticalFrame,
  type TacticalEvent,
} from '@opensamguk/shared';
import { visionRange, movementCost, ignite, updateWeather, resolveFire, terrainDefense } from './environment';
import { simulateBattle } from '../battle/simulate';
import { BALANCE } from '../balance';
import type { DeepReadonly } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { battleHash, type BattleState, type BattleUnitState, type BattleOrder } from './state';

const sides = ['attack', 'defend'] as const;
const enemy = (s: BattleSide): BattleSide => (s === 'attack' ? 'defend' : 'attack');
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const alive = (u: BattleUnitState) => u.troops > 0 && u.status !== 'routed';
const morale = (b: BattleState, s: BattleSide, delta: number) => {
  b.sides[s].morale = Math.max(0, Math.min(100, b.sides[s].morale + delta));
};
export function battleStateHash(b: BattleState) {
  return battleHash({
    phase: b.phase,
    turn: b.turn,
    units: b.units,
    sides: b.sides,
    bases: b.bases,
    traps: b.traps,
    schemes: b.schemes,
    siege: b.siege,
    weather: b.weather,
    wind: b.wind,
    burningCells: b.burningCells,
    board: b.board,
    result: b.result,
  });
}
export function canEnter(
  b: DeepReadonly<BattleState>,
  u: DeepReadonly<BattleUnitState>,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= b.board.width || y >= b.board.height) return false;
  const terrain = b.board.terrain[y * b.board.width + x];
  if (!terrain || !b.cells[y * b.board.width + x]?.sourceTileId) return false;
  if (u.naval ? !['river', 'sea', 'ford', 'bridge'].includes(terrain) : ['river', 'sea'].includes(terrain))
    return false;
  // 성문이 열리기 전에는 수비 끝 열로 우회할 수 없다.
  return !(
    b.phase === 'siege' &&
    u.side === 'attack' &&
    b.siege!.gate > 0 &&
    x === b.exits.defend.x &&
    y === b.exits.defend.y
  );
}
export function validBattlePath(
  b: DeepReadonly<BattleState>,
  u: DeepReadonly<BattleUnitState>,
  plan: BattlePlan,
): boolean {
  let last = { x: u.x, y: u.y };
  for (const cell of plan.path) {
    if (!canBattleStep(b, u, last, cell)) return false;
    last = cell;
  }
  return true;
}
export function canBattleStep(
  b: DeepReadonly<BattleState>,
  u: DeepReadonly<BattleUnitState>,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  if (distance(from, to) !== 1 || !canEnter(b, u, to.x, to.y)) return false;
  if (from.x === to.x || from.y === to.y || canEnter(b, u, from.x, to.y) || canEnter(b, u, to.x, from.y)) return true;
  const a = from.y * b.board.width + from.x,
    c = to.y * b.board.width + to.x;
  return b.edges.some((e) => e[0] === Math.min(a, c) && e[1] === Math.max(a, c));
}
export function visibleTo(b: DeepReadonly<BattleState>, s: BattleSide, cell: { x: number; y: number }): boolean {
  const origins = [
    ...b.units
      .filter((u) => u.side === s && u.troops > 0 && u.status !== 'routed')
      .map((u) => ({ x: u.x, y: u.y, range: visionRange(b, u) })),
    ...b.bases.filter((o) => o.owner === s).map((o) => ({ x: o.x, y: o.y, range: visionRange(b, o, 2) })),
  ];
  if (
    cell.x < 0 ||
    cell.y < 0 ||
    cell.x >= b.board.width ||
    cell.y >= b.board.height ||
    !b.cells[cell.y * b.board.width + cell.x]?.sourceTileId
  )
    return false;
  return origins.some((o) => {
    const steps = distance(o, cell);
    if (steps > o.range) return false;
    for (let i = 1; i < steps; i++) {
      const x = Math.round(o.x + ((cell.x - o.x) * i) / steps),
        y = Math.round(o.y + ((cell.y - o.y) * i) / steps);
      if (['forest', 'mountain'].includes(b.board.terrain[y * b.board.width + x]!)) return false;
    }
    return true;
  });
}
export function recordBattleFrame(b: BattleState, events: TacticalEvent[]) {
  const frame: TacticalFrame = {
    turn: b.turn,
    environment: { weather: b.weather, wind: b.wind },
    burningCells: structuredClone(b.burningCells),
    units: b.units.map((u) => ({
      id: u.id,
      side: u.side,
      generalName: u.generalName,
      portraitId: u.portraitId,
      crewTypeName: u.crewTypeName,
      troops: u.troops,
      troopsMax: u.troopsMax,
      x: u.x,
      y: u.y,
      status: u.status,
      role: u.role,
      vision: visionRange(b, u),
      injury: u.injury,
    })),
    bases: b.bases.map((o) => ({ id: o.id, x: o.x, y: o.y, kind: o.kind, structure: o.structure, owner: o.owner })),
    totals: Object.fromEntries(
      sides.map((s) => {
        const units = b.units.filter((u) => u.side === s && alive(u));
        return [
          s,
          {
            units: units.length,
            troops: units.reduce((n, u) => n + u.troops, 0),
            rice: b.sides[s].rice,
            morale: b.sides[s].morale,
          },
        ];
      }),
    ) as TacticalFrame['totals'],
    events: structuredClone([...(b.frames.find((f) => f.turn === b.turn)?.events ?? []), ...events]),
    siege: structuredClone(b.siege),
  };
  const existing = b.frames.findIndex((f) => f.turn === b.turn);
  if (existing < 0) b.frames.push(frame);
  else b.frames[existing] = frame;
  for (const s of sides) {
    const view = structuredClone(frame);
    view.units = view.units.filter((u) => u.side === s || (u.status !== 'ambush' && visibleTo(b, s, u)));
    view.visibleCells = b.cells.flatMap((_, index) => {
      const cell = { x: index % b.board.width, y: Math.floor(index / b.board.width) };
      return visibleTo(b, s, cell) ? [cell] : [];
    });
    view.burningCells = (view.burningCells ?? []).filter((c) => visibleTo(b, s, c));
    const ids = new Set(view.units.map((u) => u.id));
    view.events = view.events.filter(
      (e) =>
        (e.actorId == null || ids.has(e.actorId)) &&
        (e.targetId == null || ids.has(e.targetId)) &&
        (e.kind !== 'trap' || s === 'defend' || (e.targetId != null && ids.has(e.targetId))),
    );
    const foes = view.units.filter((u) => u.side !== s && u.troops > 0 && u.status !== 'routed');
    view.totals[enemy(s)] = { units: foes.length, troops: foes.reduce((n, u) => n + u.troops, 0), rice: 0, morale: 0 };
    const old = b.views[s].findIndex((f) => f.turn === b.turn);
    if (old < 0) b.views[s].push(view);
    else b.views[s][old] = view;
  }
}
export function closeCouncil(b: BattleState) {
  if (b.phase !== 'council') throw Error('WINDOW_CLOSED');
  b.phase = b.defense === 'hold' ? 'siege' : 'field';
  if (b.phase === 'siege') {
    b.sides.attack.morale = 100;
    b.sides.defend.morale = 70;
  }
  if (b.defense === 'ambush')
    for (const u of b.units.filter((u) => u.side === 'defend'))
      if (['forest', 'mountain'].includes(b.board.terrain[u.y * b.board.width + u.x]!)) u.status = 'ambush';
  b.frames = [];
  b.views = { attack: [], defend: [] };
  recordBattleFrame(b, []);
  b.revision++;
  b.windowNo++;
}
function selectedAction(b: BattleState, u: BattleUnitState): BattleAction | null {
  for (const rule of u.plan?.rules ?? []) {
    const c = rule.when;
    if (
      c.kind === 'always' ||
      (c.kind === 'sideMoraleBelow' && b.sides[u.side].morale < c.value) ||
      (c.kind === 'troopsBelow' && u.troops < c.value) ||
      (c.kind === 'atCell' && c.x === u.x && c.y === u.y) ||
      (c.kind === 'enemyVisible' &&
        b.units.some(
          (v) =>
            v.side !== u.side &&
            alive(v) &&
            v.status !== 'ambush' &&
            visibleTo(b, u.side, v) &&
            distance(u, v) <= c.range,
        ))
    )
      return rule.then;
  }
  return u.plan?.fallback ?? null;
}
function stepToward(b: BattleState, u: BattleUnitState, target: { x: number; y: number }) {
  const visited = new Set([`${u.x}:${u.y}`]),
    queue = [{ x: u.x, y: u.y, first: null as { x: number; y: number } | null }];
  let best = queue[0]!;
  const occupied = new Set(b.units.filter((v) => v.id !== u.id && alive(v)).map((v) => `${v.x}:${v.y}`));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (distance(current, target) < distance(best, target)) best = current;
    if (distance(current, target) === 0) return current.first ?? undefined;
    for (let y = current.y - 1; y <= current.y + 1; y++)
      for (let x = current.x - 1; x <= current.x + 1; x++) {
        const key = `${x}:${y}`;
        if (visited.has(key) || occupied.has(key) || !canBattleStep(b, u, current, { x, y })) continue;
        visited.add(key);
        queue.push({ x, y, first: current.first ?? { x, y } });
      }
  }
  return best.first ?? undefined;
}
function move(
  b: BattleState,
  u: BattleUnitState,
  target: { x: number; y: number },
  events: TacticalEvent[],
  budget: number,
) {
  let remaining = budget;
  while (remaining > 0 && distance(u, target) > 0) {
    const next = stepToward(b, u, target);
    if (!next) break;
    if (!canBattleStep(b, u, u, next)) break;
    const terrain = b.board.terrain[next.y * b.board.width + next.x]!;
    const cost =
      movementCost(terrain) +
      (b.board.objects.some((o) => o.kind === 'rubble' && o.x === next.x && o.y === next.y) ? 1 : 0);
    if (cost > remaining) break;
    const cell = b.cells[next.y * b.board.width + next.x]!;
    const sp = u.side === 'attack' ? cell.spCost : cell.defendSpCost;
    if (u.sp !== null && u.sp < sp) {
      u.troops = 0;
      u.status = 'routed';
      events.push({ kind: 'retreat', actorId: u.id, text: '보급 고갈: 병력 해산' });
      break;
    }
    if (u.sp !== null) u.sp -= sp;
    if (u.status === 'ambush') u.status = 'normal';
    u.x = next.x;
    u.y = next.y;
    remaining -= cost;
    events.push({ kind: 'move', actorId: u.id, text: `${u.generalName} 이동 (${u.x},${u.y})` });
    const trap = b.traps.find((t) => !t.spent && u.side === 'attack' && t.x === u.x && t.y === u.y);
    if (trap) {
      trap.spent = true;
      trap.revealed = true;
      if (trap.kind === 'fire') ignite(b, u, 'trap');
      if (trap.kind === 'pit') remaining = 0;
      else if (trap.kind === 'poison') morale(b, u.side, -5);
      else if (trap.kind !== 'fire') u.troops = Math.max(0, u.troops - Math.ceil(u.troops * 0.05));
      events.push({ kind: 'trap', targetId: u.id, text: `${trap.kind} 함정 발동` });
      if (!u.troops || !b.sides[u.side].morale) break;
    }
  }
}
function finish(b: BattleState, result: BattleSide, reason: string, events: TacticalEvent[]) {
  b.phase = 'ended';
  b.result = result;
  b.reason = reason;
  events.push({ kind: 'end', text: reason });
}
function siegeExchange(
  b: BattleState,
  u: BattleUnitState,
  unitSet: DeepReadonly<UnitSetResource>,
  events: TacticalEvent[],
) {
  const siege = b.siege!,
    beforeA = u.troops,
    defenseBefore = siege.defense,
    gateBefore = siege.gate;
  const fortification = Math.max(defenseBefore, gateBefore);
  if (fortification === 0) return;
  const result = simulateBattle(
    {
      attacker: { crew: u.troops, crewType: u.crewType, train: u.train, atmos: b.sides.attack.morale },
      defender: { crew: fortification, crewType: 1000, train: 100, atmos: b.sides.defend.morale },
      attackerTech: u.combat.tech,
      defenderTech: 0,
      defence: b.fortificationDefence,
      siege: true,
      attackerFirstVolleyUsed: u.volley,
      attackerModifiers: u.combat,
      coefMode: 'multiply',
      unitSet,
    },
    rngFor(b.seed, 'tactical', b.rulesVersion, b.id, b.turn, u.id, 'siege'),
  );
  const damage = fortification - result.defender.crew;
  u.troops = result.attacker.crew;
  u.volley = true;
  siege.defense = Math.max(0, siege.defense - damage);
  siege.gate = Math.max(0, siege.gate - damage);
  events.push({
    kind: 'siege',
    actorId: u.id,
    text: `성벽 ${siege.defense}, 성문 ${siege.gate}`,
    exchange: {
      attacker: u.generalName,
      attackerBefore: beforeA,
      attackerAfter: u.troops,
      defender: '성벽·성문',
      defenderBefore: fortification,
      defenderAfter: result.defender.crew,
    },
    fortification: { defenseBefore, defenseAfter: siege.defense, gateBefore, gateAfter: siege.gate },
  });
}
function defeat(b: BattleState, events: TacticalEvent[]) {
  const defeated = (s: BattleSide) => b.sides[s].morale === 0 || !b.units.some((u) => u.side === s && alive(u));
  if (defeated('attack')) {
    finish(b, 'defend', '공격군 패배', events);
    return true;
  }
  if (defeated('defend')) {
    if (b.phase === 'field' && b.siege && (b.siege.defense > 0 || b.siege.gate > 0) && b.turn === 30) {
      finish(b, 'defend', '30턴 야전 종료: 공성 시간 부족', events);
      return true;
    }
    if (b.phase === 'field' && b.siege && (b.siege.defense > 0 || b.siege.gate > 0) && b.turn < 30) {
      b.phase = 'siege';
      b.sides.attack.morale = 100;
      b.sides.defend.morale = 70;
      for (const u of b.units.filter((u) => u.side === 'defend' && u.troops > 0)) u.status = 'normal';
      events.push({ kind: 'siege', text: '야전 승리, 공성전 전환' });
    } else if (b.phase === 'siege' && b.siege && (b.siege.defense > 0 || b.siege.gate > 0)) return false;
    else {
      finish(b, 'attack', '거점 점령', events);
      return true;
    }
  }
  return false;
}
export function resolveBattleTurn(
  original: BattleState,
  orders: BattleOrder[],
  unitSet: DeepReadonly<UnitSetResource>,
): BattleState {
  const b = structuredClone(original);
  if (!['field', 'siege'].includes(b.phase) || b.turn >= 30) throw Error('WINDOW_CLOSED');
  if (
    new Set(orders.map((o) => o.unitId)).size !== orders.length ||
    orders.some((o) => !b.units.some((u) => u.id === o.unitId))
  )
    throw Error('BAD_INPUT');
  const beforeHash = battleStateHash(b),
    events: TacticalEvent[] = [];
  b.turn++;
  updateWeather(b);
  const haste = new Set<BattleSide>();
  for (const scheme of b.schemes.filter((s) => !s.used && s.turn === b.turn)) {
    scheme.used = true;
    if (scheme.kind === 'fire' && b.weather === 'downpour') {
      events.push({ kind: 'scheme', text: `${scheme.side} 호우로 화계 취소` });
      continue;
    }
    const cost = scheme.kind === 'search' ? 2 : 3;
    if (b.sides[scheme.side].schemePoints < cost) {
      events.push({ kind: 'scheme', text: `${scheme.side} 책략 점수 부족` });
      continue;
    }
    b.sides[scheme.side].schemePoints -= cost;
    if (scheme.kind === 'inspire') morale(b, scheme.side, 10);
    if (scheme.kind === 'haste') haste.add(scheme.side);
    if (scheme.kind === 'fire') ignite(b, scheme, `scheme:${scheme.side}`);
    if (scheme.kind === 'search') {
      for (const t of b.traps) if (distance(t, scheme) <= 1) t.revealed = true;
      for (const u of b.units)
        if (u.side !== scheme.side && u.status === 'ambush' && distance(u, scheme) <= 1) u.status = 'normal';
    }
    events.push({ kind: 'scheme', text: `${scheme.side} ${scheme.kind}` });
  }
  const resolved: BattleOrder[] = [];
  for (const order of orders.filter((o) => o.action.kind === 'withdraw')) {
    const side = b.units.find((u) => u.id === order.unitId)!.side;
    for (const u of b.units.filter((u) => u.side === side)) u.status = 'routed';
    events.push({ kind: 'retreat', actorId: order.unitId, text: '총대장 철수 지시' });
  }
  if (orders.some((o) => o.action.kind === 'withdraw')) defeat(b, events);
  for (const u of [...b.units].sort((a, c) => a.order - c.order || c.intelligence - a.intelligence || a.id - c.id)) {
    if (b.phase === 'ended') break;
    if (!alive(u)) continue;
    const enemies = b.units
      .filter((v) => v.side !== u.side && alive(v) && v.status !== 'ambush' && visibleTo(b, u.side, v))
      .sort((a, c) => distance(u, a) - distance(u, c) || a.id - c.id);
    const direct = orders.find((o) => o.unitId === u.id)?.action;
    const action =
      direct ??
      selectedAction(b, u) ??
      (enemies[0] && distance(u, enemies[0]) <= u.range
        ? { kind: 'attack', target: 'nearest' }
        : u.side === 'defend' && u.sp === 0
          ? { kind: 'hold' }
          : { kind: 'capture' });
    resolved.push({ unitId: u.id, action });
    if (action.kind === 'attack') {
      const target = action.target === 'nearest' ? enemies[0] : enemies.find((v) => v.id === action.target);
      if (
        b.phase === 'siege' &&
        u.side === 'attack' &&
        b.siege &&
        (b.siege.gate > 0 || b.siege.defense > 0) &&
        distance(u, b.exits.defend) <= u.range
      ) {
        if (u.status === 'ambush') u.status = 'normal';
        siegeExchange(b, u, unitSet, events);
      } else if (target && distance(u, target) <= u.range) {
        if (u.status === 'ambush') u.status = 'normal';
        const beforeA = u.troops,
          beforeD = target.troops;
        const result = simulateBattle(
          {
            attacker: { crew: u.troops, crewType: u.crewType, train: u.train, atmos: b.sides[u.side].morale },
            defender: {
              crew: target.troops,
              crewType: target.crewType,
              train: target.train,
              atmos: b.sides[target.side].morale,
            },
            attackerTech: u.combat.tech,
            defenderTech: target.combat.tech,
            unitSet,
            attackerFirstVolleyUsed: u.volley,
            siege: target.volley,
            attackerModifiers: {
              ...u.combat,
              taken: [...u.combat.taken, { source: 'field:earthwork', op: 'mul', value: terrainDefense(b, u) }],
            },
            defenderModifiers: {
              ...target.combat,
              taken: [
                ...target.combat.taken,
                { source: 'field:earthwork', op: 'mul', value: terrainDefense(b, target) },
              ],
            },
            coefMode: 'multiply',
          },
          rngFor(b.seed, 'tactical', b.rulesVersion, b.id, b.turn, u.id, 'exchange'),
        );
        u.troops = result.attacker.crew;
        target.troops = result.defender.crew;
        u.volley = true;
        target.volley = true;
        events.push({
          kind: 'attack',
          actorId: u.id,
          targetId: target.id,
          text: '교전',
          exchange: {
            attacker: u.generalName,
            attackerBefore: beforeA,
            attackerAfter: u.troops,
            defender: target.generalName,
            defenderBefore: beforeD,
            defenderAfter: target.troops,
          },
        });
      }
    } else if (action.kind !== 'hold') {
      let target: { x: number; y: number } | undefined;
      if (action.kind === 'move') target = action;
      else if (action.kind === 'retreat') target = b.exits[u.side];
      else if (action.kind === 'followPath') target = u.plan?.path[u.cursor];
      else
        target =
          enemies[0] ??
          (b.phase === 'siege' && u.side === 'attack'
            ? b.exits.defend
            : b.bases
                .filter((o) => o.owner !== u.side)
                .sort((a, c) => distance(u, a) - distance(u, c) || a.id - c.id)[0]);
      if (b.phase === 'siege' && u.side === 'attack' && distance(u, b.exits.defend) <= 1 && b.siege) {
        siegeExchange(b, u, unitSet, events);
      } else if (target) move(b, u, target, events, u.move + (haste.has(u.side) ? 1 : 0));
      if (action.kind === 'followPath' && target && distance(u, target) === 0) u.cursor++;
      if (action.kind === 'retreat' && distance(u, b.exits[u.side]) === 0) {
        u.status = 'routed';
        events.push({ kind: 'retreat', actorId: u.id, text: '퇴각 완료' });
      }
    }
    if (defeat(b, events) || b.phase !== original.phase) break;
  }
  if (b.phase !== 'ended') {
    resolveFire(b, events);
    defeat(b, events);
  }
  if (b.phase !== 'ended') {
    for (const base of b.phase !== original.phase ? [] : b.bases) {
      const occupiers = b.units.filter((u) => alive(u) && u.x === base.x && u.y === base.y);
      const s = occupiers[0]?.side;
      if (s && occupiers.every((u) => u.side === s) && base.owner !== s) {
        const old = base.owner;
        base.owner = s;
        if (!base.rewarded) {
          morale(b, s, 5);
          if (old) morale(b, old, -5);
          base.rewarded = true;
        }
        events.push({ kind: 'capture', actorId: occupiers[0]!.id, text: `거점 ${base.id} 점령` });
      }
    }
    const owns = (id: number) => b.bases.some((o) => o.id === id && o.owner === 'attack');
    const routes = [
      { key: 'front', limit: 15, reward: 40, ok: owns(2) },
      { key: 'left', limit: 20, reward: 60, ok: owns(1) },
      { key: 'right', limit: 20, reward: 60, ok: owns(3) },
      { key: 'encircle', limit: 25, reward: 80, ok: owns(1) && owns(3) },
    ];
    const achieved = routes
      .filter((r) => r.ok && b.turn <= r.limit)
      .sort((a, c) => Number(c.key === b.route) - Number(a.key === b.route) || c.reward - a.reward)[0];
    if (achieved && b.phase === original.phase && !b.sides.attack.routeReward) {
      b.sides.attack.routeReward = true;
      const gain = achieved.reward / (achieved.key === b.route ? 1 : 2);
      morale(b, 'attack', gain);
      morale(b, 'defend', -gain);
      events.push({ kind: 'morale', text: `${achieved.key} 달성 +${gain}/-${gain}` });
    }
    for (const s of sides) {
      let need = b.units
        .filter((u) => u.side === s && alive(u))
        .reduce((n, u) => n + Math.ceil(u.troops * BALANCE.BATTLE_RICE_PER_CREW), 0);
      const shortage = need > b.sides[s].rice;
      for (const owner of b.sides[s].riceOwners) {
        const paid = Math.min(owner.remaining, need);
        owner.remaining -= paid;
        need -= paid;
      }
      b.sides[s].rice = b.sides[s].riceOwners.reduce((n, o) => n + o.remaining, 0);
      if (shortage || b.sides[s].rice === 0) morale(b, s, -10);
    }
    defeat(b, events);
    if (b.result === null && b.turn === 30) finish(b, 'defend', '30턴 상한: 공격 철수', events);
  }
  b.revision++;
  b.windowNo++;
  recordBattleFrame(b, events);
  b.records.push({ turn: b.turn, beforeHash, afterHash: battleStateHash(b), orders: resolved, events });
  return b;
}
