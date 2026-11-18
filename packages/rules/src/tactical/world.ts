import { rngFor, battleStructureSchema, type BattleSide } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { captureCounties } from '../cityAffiliation';
import { removeNation } from '../commands/support';
import { refreshSupply } from '../supply';
import type { WorldState, WorldView, DeepReadonly } from '../model/world';
import type { CampaignUnitState } from '../campaign/state';
import type { UnitSetResource } from '../world/resources';
import { battleHash, type BattleState, type BattleUnitState } from './state';
import { recordBattleFrame, canEnter, canBattleStep } from './battle';
import { tacticalMap } from './map';
import { rollEnvironment } from './environment';
import { TICKS_PER_MONTH } from '../clock/constants';
import { collectModifiers } from '../modifiers';
import { commanderBattleModifiers } from '../general/fiveStatsBattle';
import { equipmentBonus } from '../equipment/stats';
import { resolveMarchRoute } from '../campaign/supply';
import { disbandCityGarrison } from '../cityResources/ownership';

export function activeBattles(view: WorldView) {
  return view.campaign?.tactical?.battles.filter((b) => !b.settled) ?? [];
}
export function battleBusy(
  view: WorldView,
  targets: { generalIds?: readonly number[]; unitIds?: readonly number[]; cityKeys?: readonly number[] },
) {
  return activeBattles(view).some(
    (b) =>
      targets.cityKeys?.includes(b.targetCityKey) ||
      b.units.some(
        (u) =>
          targets.unitIds?.includes(u.sourceId ?? -1) ||
          targets.generalIds?.includes(u.ownerId ?? -1) ||
          targets.generalIds?.includes(u.commanderId ?? -1),
      ),
  );
}
export function battleCommandBusy(view: WorldView, actorId: number, key: string, raw: unknown) {
  const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const moving = [
    'move',
    'return',
    'attack',
    'recruit',
    'conscript',
    'disband',
    'assign',
    'appoint',
    'dismiss',
    'leave',
    'resign',
  ];
  const ids = ['generalId', 'targetId', 'recipientId', 'commanderId'].flatMap((k) =>
    typeof args[k] === 'number' ? [args[k] as number] : [],
  );
  return (
    battleBusy(view, {
      unitIds: typeof args.unitId === 'number' ? [args.unitId] : [],
      cityKeys: typeof args.cityKey === 'number' ? [args.cityKey] : [],
    }) ||
    (moving.some((k) => key.includes(k)) && battleBusy(view, { generalIds: [actorId, ...ids] }))
  );
}
export function openTacticalBattle(
  state: WorldState,
  tick: number,
  force: readonly DeepReadonly<CampaignUnitState>[],
  defenders: readonly DeepReadonly<CampaignUnitState>[],
  targetCityKey: number,
  unitSet: DeepReadonly<UnitSetResource>,
  options: Parameters<typeof resolveMarchRoute>[3] = {},
): BattleState {
  if (
    battleBusy(state, {
      unitIds: [...force, ...defenders].map((u) => u.id),
      generalIds: [...force, ...defenders].flatMap((u) => [u.ownerId, u.commanderId]),
      cityKeys: [targetCityKey],
    })
  )
    throw Error('BATTLE_BUSY');
  const originCityKey = state.generals[force[0]!.ownerId]!.cityKey;
  const route = resolveMarchRoute(state, force[0]!, targetCityKey, options);
  if (!route) throw Error('전장 경로 원장이 없습니다.');
  const nationId = state.generals[force[0]!.ownerId]!.nationId;
  const map = tacticalMap(state, route, targetCityKey, nationId),
    city = state.cities[targetCityKey]!;
  const makeArmy = (id: number | null): BattleState['sides']['attack'] => {
    const nation = id === null ? null : state.nations[id]!;
    return {
      nationId: id,
      nationName: nation?.name ?? '무주',
      color: nation?.color ?? '#777777',
      commanderId: null,
      advisorId: null,
      commander: '도시 수비',
      strategist: null,
      schemePoints: 0,
      morale: 100,
      rice: 0,
      riceOwners: [],
      ready: false,
      routeReward: false,
    };
  };
  state.campaign!.tactical ??= { nextId: 1, battles: [] };
  state.campaign!.tactical.battles = state.campaign!.tactical.battles.filter((b) => !b.settled);
  const ledger = state.campaign!.tactical;
  const b: BattleState = {
    formatVersion: 1,
    rulesVersion: 'tactical-v1',
    unitSetHash: battleHash(unitSet),
    id: `tactical:${tick}:${ledger.nextId++}`,
    revision: 0,
    tick,
    year: state.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH)),
    month: (Math.floor(tick / TICKS_PER_MONTH) % 12) + 1,
    place: city.name,
    seed: state.campaign!.seed,
    targetCityKey,
    originCityKey,
    fortificationDefence: city.defence,
    settled: false,
    phase: 'council',
    mode: 'RESERVED',
    turn: 0,
    windowNo: 0,
    deadlineAt: 0,
    hardDeadlineAt: 0,
    pausedAt: null,
    fault: null,
    turnMs: 0,
    councilMs: 120000,
    mapHash: battleHash(map),
    ...rollEnvironment(
      rngFor(state.campaign!.seed, 'tactical', 'tactical-v1', tick, ledger.nextId - 1, 'weather-start'),
    ),
    burningCells: [],
    board: map.board,
    cells: map.cells,
    edges: map.edges,
    exits: map.exits,
    route: 'front',
    defense: 'intercept',
    sides: { attack: makeArmy(nationId), defend: makeArmy(city.nationId) },
    units: [],
    bases: [],
    traps: [],
    schemes: [],
    siege:
      city.kind === 'FIELD' ? null : { defense: city.wall, defenseMax: city.wall, gate: city.wall, gateMax: city.wall },
    frames: [],
    views: { attack: [], defend: [] },
    records: [],
    receipts: [],
    result: null,
    reason: null,
  };
  const category = (armType: number) => unitSet.armTypes[String(armType)] ?? '';
  const combat = (id: number) => {
    const g = state.generals[id]!,
      bonus = equipmentBonus(state, id);
    const base = commanderBattleModifiers(
      {
        leadership: g.leadership,
        strength: g.strength,
      },
      { leadership: bonus.leadership, strength: bonus.strength },
    );
    return {
      tech: g.nationId === null ? 0 : state.nations[g.nationId]!.tech,
      dealt: [...collectModifiers(state, id, { stage: 'battle.dealt', commandKey: 'attack' }), ...base.dealt],
      taken: [...collectModifiers(state, id, { stage: 'battle.taken', commandKey: 'attack' }), ...base.taken],
    };
  };
  function add(
    row: {
      id: number;
      ownerId: number | null;
      commanderId: number | null;
      troops: number;
      crewType: number;
      train: number;
      supply?: DeepReadonly<CampaignUnitState['supply']>;
    },
    side: BattleSide,
  ) {
    const general = row.commanderId === null ? null : state.generals[row.commanderId]!,
      crew = unitSet.crewTypes.find((c) => c.id === row.crewType);
    if (!crew) throw Error('전장 병종이 없습니다.');
    const type = category(crew.armType);
    const u: BattleUnitState = {
      id: row.id,
      sourceId: row.commanderId === null ? null : row.id,
      ownerId: row.ownerId,
      commanderId: row.commanderId,
      side,
      generalName: general?.name ?? city.name + ' 수비병',
      portraitId: general?.portraitId ?? null,
      crewTypeName: crew.name,
      crewType: row.crewType,
      troops: row.troops,
      troopsMax: row.troops,
      train: row.train,
      intelligence: general?.intel ?? 0,
      leadership: general?.leadership ?? 0,
      strength: general?.strength ?? 0,
      injury: 0,
      x: 0,
      y: 0,
      sp: row.supply?.remaining ?? null,
      loadedSp: row.supply?.loaded ?? null,
      originCityKey: row.supply?.originCityKey ?? (side === 'attack' ? originCityKey : targetCityKey),
      order: type.includes('수군')
        ? 4
        : type.includes('공성')
          ? 3
          : type.includes('궁')
            ? 2
            : type.includes('기병')
              ? 1
              : 0,
      move: type.includes('기병') ? 3 : type.includes('공성') ? 1 : 2,
      range: type.includes('궁') ? 2 : 1,
      naval: type.includes('수군'),
      volley: false,
      status: 'normal',
      role: null,
      cursor: 0,
      plan: null,
      combat: general
        ? combat(general.id)
        : { tech: city.nationId === null ? 0 : state.nations[city.nationId]!.tech, dealt: [], taken: [] },
    };
    b.units.push(u);
  }
  force.forEach((u) => add(u, 'attack'));
  defenders.forEach((u) => add(u, 'defend'));
  for (const row of state.cityResources?.cities[String(targetCityKey)]?.garrison ?? [])
    if (row.troops > 0) add({ ...row, id: -row.crewType, ownerId: null, commanderId: null }, 'defend');
  const defenseStock = state.cityResources?.cities[String(targetCityKey)];
  const unloaded = b.units.filter((u) => u.side === 'defend' && u.sp === null);
  if (defenseStock && unloaded.length) {
    const costPerSp = Math.ceil(unloaded.reduce((n, u) => n + u.troops, 0) / 100);
    const loaded = Math.min(100, Math.floor(defenseStock.rice / Math.max(1, costPerSp)));
    defenseStock.rice -= loaded * costPerSp;
    for (const u of unloaded) {
      u.sp = loaded;
      u.loadedSp = loaded;
      const source = state.campaign!.units.find((row) => row.id === u.sourceId);
      if (source && loaded > 0)
        source.supply = {
          feature: 'march-supply-v1',
          unit: 'SP',
          loaded,
          remaining: loaded,
          originCityKey: targetCityKey,
        };
    }
  }
  if (b.units.length > 40 || b.units.length > map.path.length) throw Error('전장 배치 공간이 부족합니다.');
  const occupied = new Set<string>();
  for (const side of ['attack', 'defend'] as const) {
    const own = b.units.filter((u) => u.side === side);
    for (const u of own) {
      const options = side === 'attack' ? map.path : [...map.path].reverse();
      const cell = options.find((c) => !occupied.has(`${c.x}:${c.y}`) && canEnter(b, u, c.x, c.y));
      if (!cell) throw Error('병종이 통행할 수 있는 전장 배치 칸이 없습니다.');
      u.x = cell.x;
      u.y = cell.y;
      occupied.add(`${u.x}:${u.y}`);
    }
    const people = [...new Set(own.flatMap((u) => (u.commanderId === null ? [] : [u.commanderId])))].map(
      (id) => state.generals[id]!,
    );
    const commander = [...people].sort(
      (a, c) =>
        Number(c.officerLevel === BALANCE.RULER_LEVEL) - Number(a.officerLevel === BALANCE.RULER_LEVEL) ||
        Number(c.officerLevel === 4 && c.officerCityKey === targetCityKey) -
          Number(a.officerLevel === 4 && a.officerCityKey === targetCityKey) ||
        c.strength - a.strength ||
        a.id - c.id,
    )[0];
    const advisor = [...people].sort(
      (a, c) => Number(c.officerLevel === 3) - Number(a.officerLevel === 3) || c.intel - a.intel || a.id - c.id,
    )[0];
    const army = b.sides[side];
    army.commanderId = commander?.id ?? null;
    army.advisorId = advisor?.id ?? null;
    army.commander = commander?.name ?? '도시 수비';
    army.strategist = advisor?.name ?? null;
    army.schemePoints = advisor ? Math.min(10, Math.floor(advisor.intel / 10)) : 0;
    for (const u of own)
      u.role = u.commanderId === commander?.id ? 'commander' : u.commanderId === advisor?.id ? 'strategist' : null;
    for (const ownerId of [...new Set(own.flatMap((u) => (u.ownerId === null ? [] : [u.ownerId])))]) {
      const general = state.generals[ownerId]!,
        need = own
          .filter((u) => u.ownerId === ownerId)
          .reduce((n, u) => n + Math.ceil(u.troops * BALANCE.BATTLE_RICE_PER_CREW) * 30, 0),
        loaded = Math.min(general.rice, need);
      general.rice -= loaded;
      army.riceOwners.push({ kind: 'general', id: ownerId, remaining: loaded });
      army.rice += loaded;
    }
    const garrison = own.filter((u) => u.sourceId === null),
      resource = state.cityResources?.cities[String(targetCityKey)];
    if (garrison.length && resource) {
      const loaded = Math.min(
        resource.rice,
        garrison.reduce((n, u) => n + Math.ceil(u.troops * BALANCE.BATTLE_RICE_PER_CREW) * 30, 0),
      );
      resource.rice -= loaded;
      army.riceOwners.push({ kind: 'city', id: targetCityKey, remaining: loaded });
      army.rice += loaded;
    }
  }
  for (const u of b.units.filter((u) => u.side === 'attack')) {
    const queue = [{ x: u.x, y: u.y }],
      seen = new Set([`${u.x}:${u.y}`]);
    let reached = false;
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      if (Math.max(Math.abs(at.x - b.exits.defend.x), Math.abs(at.y - b.exits.defend.y)) <= u.range) {
        reached = true;
        break;
      }
      for (let y = at.y - 1; y <= at.y + 1; y++)
        for (let x = at.x - 1; x <= at.x + 1; x++)
          if (!seen.has(`${x}:${y}`) && canBattleStep(b, u, at, { x, y })) {
            seen.add(`${x}:${y}`);
            queue.push({ x, y });
          }
    }
    if (!reached) throw Error('해당 병종의 검증된 도하·수상 전장이 없습니다.');
  }
  b.sides.attack.morale = map.board.terrain.includes('mountain') ? 70 : map.board.terrain.includes('sea') ? 80 : 100;
  const objectives = map.path.filter((c) => !occupied.has(`${c.x}:${c.y}`));
  for (let i = 1; i <= Math.min(5, objectives.length); i++) {
    const cell = objectives[Math.floor(((i - 0.5) * objectives.length) / Math.min(5, objectives.length))]!;
    const scenery = b.board.objects.find((o) => o.x === cell.x && o.y === cell.y);
    const baseStructure = battleStructureSchema.safeParse(scenery?.kind);
    b.bases.push({
      id: i,
      ...cell,
      kind: 'contest',
      structure: baseStructure.success ? baseStructure.data : 'camp',
      owner: null,
      rewarded: false,
    });
    if (!b.board.objects.some((o) => o.x === cell.x && o.y === cell.y)) b.board.objects.push({ ...cell, kind: 'camp' });
  }
  const structure =
    city.kind === 'PASS'
      ? 'gate'
      : city.kind === 'FIELD'
        ? 'camp'
        : city.level <= 2
          ? 'village'
          : city.level <= 4
            ? 'fort-small'
            : city.level <= 7
              ? 'fort-medium'
              : 'fort-large';
  const targetCell = b.exits.defend;
  if (!b.board.objects.some((o) => o.x === targetCell.x && o.y === targetCell.y))
    b.board.objects.push({
      ...targetCell,
      kind: state.cityRuins?.cities.some((r) => r.cityKey === targetCityKey) ? 'rubble' : structure,
    });
  b.mapHash = battleHash({ board: b.board, cells: b.cells, edges: b.edges, exits: b.exits });
  recordBattleFrame(b, []);
  ledger.battles.push(b);
  state.campaign!.revision++;
  return b;
}
export function battleCancellation(view: WorldView, b: DeepReadonly<BattleState>) {
  if (b.sides.attack.nationId !== null && !view.nations[b.sides.attack.nationId]) return '공격 국가 멸망';
  if (b.sides.defend.nationId !== null && !view.nations[b.sides.defend.nationId]) return '수비 국가 멸망';
  if (view.cities[b.targetCityKey]?.nationId !== b.sides.defend.nationId) return '대상 거점 소유 변경';
  const a = b.sides.attack.nationId,
    d = b.sides.defend.nationId;
  if (
    a !== null &&
    d !== null &&
    !view.diplomacies.some(
      (r) => r.state === 'WAR' && ((r.nationA === a && r.nationB === d) || (r.nationA === d && r.nationB === a)),
    )
  )
    return '휴전 또는 동맹: 교전 종료';
  if (
    b.units.some((u) =>
      [u.commanderId, u.ownerId].some(
        (id) =>
          id !== null &&
          (!view.generals[id] ||
            view.generals[id]!.removedAt !== undefined ||
            view.generals[id]!.nationId !== b.sides[u.side].nationId),
      ),
    )
  )
    return '참가 장수 사망·하야·소속 변경';
  return null;
}
export function settleTacticalBattle(state: WorldState, b: BattleState) {
  if (b.settled) return;
  if (b.phase !== 'ended') throw Error('끝나지 않은 전투입니다.');
  const injuries = new Map<number, number>();
  for (const u of b.units)
    if (u.commanderId !== null) injuries.set(u.commanderId, Math.max(injuries.get(u.commanderId) ?? 0, u.injury));
  for (const [id, injury] of injuries) {
    const general = state.generals[id];
    if (general && general.removedAt === undefined)
      general.injury = Math.max(general.injury, Math.min(80, general.injury + injury));
  }
  for (const u of b.units) {
    if (u.sourceId !== null) {
      const row = state.campaign!.units.find((v) => v.id === u.sourceId);
      if (!row) continue;
      row.troops = Math.max(0, row.troops - (u.troopsMax - u.troops));
      if (row.supply && u.sp !== null) row.supply.remaining = u.sp;
    } else {
      const row = state.cityResources?.cities[String(b.targetCityKey)]?.garrison.find((v) => v.crewType === u.crewType);
      if (row) row.troops = Math.max(0, row.troops - (u.troopsMax - u.troops));
    }
  }
  const city = state.cities[b.targetCityKey]!;
  const disband = (cityKey: number) => {
    if (!state.cityResources) return;
    const ended = disbandCityGarrison(state, cityKey);
    state.cityResources = ended.state.cityResources!;
    state.cities[cityKey]!.population = ended.state.cities[cityKey]!.population;
  };
  if (b.siege) city.wall = Math.max(0, city.wall - (b.siege.defenseMax - b.siege.defense));
  for (const side of ['attack', 'defend'] as const)
    for (const owner of b.sides[side].riceOwners) {
      if (owner.kind === 'general') {
        const general = state.generals[owner.id];
        if (general && general.removedAt === undefined) general.rice += owner.remaining;
      } else {
        const resource = state.cityResources?.cities[String(owner.id)];
        if (resource) resource.rice += owner.remaining;
      }
      owner.remaining = 0;
    }
  const attackingNation = b.sides.attack.nationId,
    defendingNation = b.sides.defend.nationId;
  if (
    b.result === 'attack' &&
    attackingNation !== null &&
    state.nations[attackingNation] &&
    city.nationId === defendingNation
  ) {
    city.nationId = attackingNation;
    city.defence = 0;
    city.security = Math.round(city.security * BALANCE.CAPTURE_SECURITY_FACTOR);
    city.trust = Math.max(0, city.trust - BALANCE.CAPTURE_TRUST_LOSS);
    captureCounties(state, city.cityKey);
    disband(city.cityKey);
    for (const u of b.units.filter((u) => u.side === 'attack' && u.troops > 0))
      for (const id of new Set([u.ownerId, u.commanderId]))
        if (id !== null && state.generals[id]) state.generals[id]!.cityKey = city.cityKey;
    if (defendingNation !== null && state.nations[defendingNation]) {
      const left = Object.values(state.cities)
        .filter((c) => c.nationId === defendingNation && c.kind !== 'PASS' && c.kind !== 'FIELD')
        .sort((a, c) => c.population - a.population || a.cityKey - c.cityKey);
      if (!left.length) {
        for (const other of state.campaign!.tactical!.battles.filter(
          (v) =>
            v.id !== b.id &&
            !v.settled &&
            (v.sides.attack.nationId === defendingNation || v.sides.defend.nationId === defendingNation),
        )) {
          other.phase = 'ended';
          other.result = 'defend';
          other.reason = '참가 국가 멸망';
          recordBattleFrame(other, [{ kind: 'end', text: other.reason }]);
          settleTacticalBattle(state, other);
        }
        for (const owned of Object.values(state.cities).filter((c) => c.nationId === defendingNation))
          disband(owned.cityKey);
        removeNation(state, defendingNation);
      } else if (state.nations[defendingNation]!.capitalCityKey === city.cityKey)
        state.nations[defendingNation]!.capitalCityKey = left[0]!.cityKey;
    }
    refreshSupply(state);
  }
  state.campaign!.units = state.campaign!.units.filter((u) => u.troops > 0);
  if (state.cityResources)
    for (const resource of Object.values(state.cityResources.cities))
      resource.garrison = resource.garrison.filter((u) => u.troops > 0);
  b.settled = true;
  b.revision++;
  state.campaign!.revision++;
}
export function restoreReservedMilitary(before: WorldView, after: WorldState) {
  for (const b of activeBattles(before)) {
    for (const u of b.units)
      if (u.sourceId !== null) {
        const old = before.campaign!.units.find((v) => v.id === u.sourceId),
          row = after.campaign?.units.find((v) => v.id === u.sourceId);
        if (old && row) {
          row.troops = old.troops;
          row.train = old.train;
          row.atmos = old.atmos;
        }
      }
    const old = before.cityResources?.cities[String(b.targetCityKey)],
      next = after.cityResources?.cities[String(b.targetCityKey)];
    if (old && next)
      next.garrison = structuredClone(old.garrison) as NonNullable<
        WorldState['cityResources']
      >['cities'][string]['garrison'];
    if (after.cities[b.targetCityKey]) after.cities[b.targetCityKey]!.wall = before.cities[b.targetCityKey]!.wall;
  }
}
