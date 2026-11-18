import { z } from 'zod';
import { battleCouncilInputSchema, battlePlanInputSchema, battleTurnInputSchema } from '@opensamguk/shared';
import type { InputKindDefinition } from '../ruleRegistry';
import type { WorldView, WorldState, DeepReadonly } from '../model/world';
import { cloneWorld } from '../model/clone';
import { battleHash, battleDuration, type BattleState, type BattleOrder } from './state';
import {
  closeCouncil,
  validBattlePath,
  resolveBattleTurn,
  recordBattleFrame,
  battleStateHash,
  canEnter,
} from './battle';
import { canIgnite } from './environment';
import { battleCancellation, settleTacticalBattle } from './world';
import type { UnitSetResource } from '../world/resources';

export function battleParticipant(b: DeepReadonly<BattleState>, actorId: number) {
  return b.units.find((u) => u.ownerId === actorId || u.commanderId === actorId)?.side ?? null;
}
export function canCommandBattleUnit(b: DeepReadonly<BattleState>, actorId: number, unitId: number, view: WorldView) {
  const unit = b.units.find((u) => u.id === unitId);
  if (!unit) return false;
  if (unit.ownerId === actorId || unit.commanderId === actorId) return true;
  return (
    b.sides[unit.side].commanderId === actorId && unit.ownerId !== null && view.generals[unit.ownerId]?.userId === null
  );
}
export function applyBattleInput(view: WorldView, kind: string, payload: unknown, actorId: number) {
  const schema =
    kind === 'battle.plan'
      ? battlePlanInputSchema
      : kind === 'battle.council'
        ? battleCouncilInputSchema
        : battleTurnInputSchema;
  const parsed = schema.safeParse(payload);
  const deny = (code: string) => ({ ok: false as const, code, message: code });
  if (!parsed.success) return deny('BAD_INPUT');
  const input = parsed.data;
  const state = cloneWorld(view),
    b = state.campaign?.tactical?.battles.find((b) => b.id === input.battleId);
  if (!b || !battleParticipant(b, actorId)) return deny('NOT_FOUND');
  if (b.settled || b.phase === 'ended' || b.fault || b.pausedAt !== null) return deny('WINDOW_CLOSED');
  if (input.mapHash !== b.mapHash) return deny('MAP_MISMATCH');
  if (input.windowNo !== b.windowNo) return deny('WINDOW_CLOSED');
  if (kind !== 'battle.turn' && input.expectedRevision !== b.revision) return deny('STALE_REVISION');
  const side = battleParticipant(b, actorId)!,
    army = b.sides[side];
  if (kind === 'battle.plan') {
    if (b.phase !== 'council') return deny('WINDOW_CLOSED');
    const data = battlePlanInputSchema.parse(payload);
    if (new Set(data.units.map((p) => p.unitId)).size !== data.units.length) return deny('BAD_INPUT');
    for (const plan of data.units) {
      const unit = b.units.find((u) => u.id === plan.unitId);
      if (!unit || !canCommandBattleUnit(b, actorId, unit.id, view)) return deny('NOT_ALLOWED');
      if (!validBattlePath(b, unit, plan)) return deny('ILLEGAL_PATH');
      if (
        [plan.fallback, ...plan.rules.map((r) => r.then)].some(
          (a) => a.kind === 'withdraw' || (a.kind === 'move' && !canEnter(b, unit, a.x, a.y)),
        )
      )
        return deny('ILLEGAL_PATH');
      unit.plan = plan;
      unit.cursor = 0;
    }
  } else if (kind === 'battle.council') {
    if (b.phase !== 'council') return deny('WINDOW_CLOSED');
    const data = battleCouncilInputSchema.parse(payload);
    if ((data.route !== undefined || data.defense !== undefined || data.ready) && army.commanderId !== actorId)
      return deny('NOT_ALLOWED');
    if ((data.route && side !== 'attack') || (data.defense && side !== 'defend')) return deny('NOT_ALLOWED');
    if (
      (data.traps && (side !== 'defend' || army.advisorId !== actorId)) ||
      (data.schemes && army.advisorId !== actorId)
    )
      return deny('NOT_ALLOWED');
    if (data.defense === 'hold' && !b.siege) return deny('BAD_INPUT');
    if (data.defense === 'ambush' && !b.board.terrain.some((t) => t === 'forest' || t === 'mountain'))
      return deny('BAD_INPUT');
    if (data.placements) {
      if (new Set(data.placements.map((p) => p.unitId)).size !== data.placements.length) return deny('BAD_INPUT');
      for (const p of data.placements) {
        const u = b.units.find((v) => v.id === p.unitId);
        if (!u || !canCommandBattleUnit(b, actorId, p.unitId, view)) return deny('NOT_ALLOWED');
        if (!canEnter(b, u, p.x, p.y)) return deny('ILLEGAL_PATH');
        const other = b.exits[side === 'attack' ? 'defend' : 'attack'],
          own = b.exits[side];
        if (
          Math.max(Math.abs(p.x - own.x), Math.abs(p.y - own.y)) >
          Math.max(Math.abs(p.x - other.x), Math.abs(p.y - other.y))
        )
          return deny('ILLEGAL_PATH');
        u.x = p.x;
        u.y = p.y;
        u.plan = null;
        u.cursor = 0;
      }
      if (new Set(b.units.map((u) => `${u.x}:${u.y}`)).size !== b.units.length) return deny('ILLEGAL_PATH');
    }
    if (data.route) b.route = data.route;
    if (data.defense) b.defense = data.defense;
    if (data.traps) {
      if (data.traps.length * 2 > army.schemePoints + b.traps.length * 2) return deny('INSUFFICIENT_POINTS');
      if (new Set(data.traps.map((t) => `${t.x}:${t.y}`)).size !== data.traps.length) return deny('BAD_INPUT');
      for (const t of data.traps) {
        const terrain = b.board.terrain[t.y * b.board.width + t.x];
        if (
          Math.max(Math.abs(t.x - b.exits.defend.x), Math.abs(t.y - b.exits.defend.y)) >
            Math.max(Math.abs(t.x - b.exits.attack.x), Math.abs(t.y - b.exits.attack.y)) ||
          t.x >= b.board.width ||
          t.y >= b.board.height ||
          !b.cells[t.y * b.board.width + t.x]?.sourceTileId ||
          b.units.some((u) => u.x === t.x && u.y === t.y) ||
          b.bases.some((o) => o.x === t.x && o.y === t.y)
        )
          return deny('ILLEGAL_PATH');
        // 원장에 수문·급수 태그가 없으므로 물·독 함정은 제출 불가다.
        if (
          t.kind === 'water' ||
          t.kind === 'poison' ||
          (t.kind === 'rock' && terrain !== 'mountain') ||
          (t.kind === 'pit' && !['grass', 'plain', 'road'].includes(terrain ?? '')) ||
          (t.kind === 'fire' && !['grass', 'bridge'].includes(terrain ?? ''))
        )
          return deny('BAD_TERRAIN');
      }
      army.schemePoints += b.traps.length * 2 - data.traps.length * 2;
      b.traps = data.traps.map((t) => ({ ...t, spent: false, revealed: false }));
    }
    if (data.schemes) {
      if (
        new Set(data.schemes.map((s) => `${s.turn}:${s.kind}`)).size !== data.schemes.length ||
        data.schemes.some(
          (s) => s.x >= b.board.width || s.y >= b.board.height || !b.cells[s.y * b.board.width + s.x]?.sourceTileId,
        )
      )
        return deny('BAD_INPUT');
      if (data.schemes.some((s) => s.kind === 'fire' && !canIgnite(b, s))) return deny('BAD_TERRAIN');
      b.schemes = b.schemes
        .filter((s) => s.side !== side)
        .concat(data.schemes.map((s) => ({ ...s, side, used: false })));
    }
    army.ready = data.ready;
  } else {
    if (b.phase === 'council' || b.mode !== 'LIVE') return deny('WINDOW_CLOSED');
    const data = battleTurnInputSchema.parse(payload);
    if (data.turnNo !== b.turn + 1) return deny('WINDOW_CLOSED');
    if (!canCommandBattleUnit(b, actorId, data.unitId, view)) return deny('NOT_ALLOWED');
    if (data.action.kind === 'withdraw' && army.commanderId !== actorId) return deny('NOT_ALLOWED');
    if (
      data.action.kind === 'move' &&
      !canEnter(
        b,
        b.units.find((u) => u.id === data.unitId)!,
        data.action.x,
        data.action.y,
      )
    )
      return deny('ILLEGAL_PATH');
    // 직접 명령은 별도 수신 원장에서 부대별 revision을 검사하고 마감에 확정한다.
    return { ok: true as const, state, result: { battleRevision: b.revision, windowNo: b.windowNo } };
  }
  b.revision++;
  return { ok: true as const, state, result: { battleRevision: b.revision, windowNo: b.windowNo } };
}
export const battleStepSchema = z.strictObject({
  battleId: z.string(),
  now: z.number().int().nonnegative(),
  turnTermMinutes: z.number().positive(),
  present: z.boolean(),
  orders: z.array(z.object({ unitId: z.number().int(), action: battleTurnInputSchema.shape.action })),
  cancel: z.string().nullable(),
  fault: z.string().nullable().optional(),
  receipts: z
    .array(z.object({ id: z.string(), status: z.enum(['APPLIED', 'REJECTED']), reason: z.string().nullable() }))
    .optional(),
});
export function applyBattleStep(view: WorldView, payload: unknown, unitSet: DeepReadonly<UnitSetResource>): WorldState {
  const input = battleStepSchema.parse(payload),
    state = cloneWorld(view);
  const b = state.campaign?.tactical?.battles.find((b) => b.id === input.battleId);
  if (!b || b.settled) throw Error('이미 정산했거나 없는 전투입니다.');
  if (input.fault) {
    b.fault = input.fault;
    b.revision++;
    return state;
  }
  b.receipts.push(...(input.receipts ?? []));
  const cancel = input.cancel ?? battleCancellation(state, b);
  if (cancel) {
    b.phase = 'ended';
    b.result = 'defend';
    b.reason = cancel;
    recordBattleFrame(b, [{ kind: 'end', text: cancel }]);
    settleTacticalBattle(state, b);
    return state;
  }
  if (b.unitSetHash !== battleHash(unitSet)) throw Error('전투 병종 자원 해시가 다릅니다.');
  if (!b.deadlineAt) {
    const duration = battleDuration(input.turnTermMinutes);
    b.turnMs = duration.turnMs;
    b.councilMs = duration.councilMs;
    b.deadlineAt = input.now + b.councilMs;
    b.hardDeadlineAt = input.now + Math.max(input.turnTermMinutes * 60000, b.councilMs);
    b.revision++;
    return state;
  }
  if (b.phase === 'council') {
    const human = Object.values(b.sides).some(
      (s) => s.commanderId !== null && state.generals[s.commanderId]?.userId !== null,
    );
    if (
      input.now < b.deadlineAt &&
      human &&
      !Object.values(b.sides).every(
        (s) => s.ready || s.commanderId === null || state.generals[s.commanderId]?.userId === null,
      )
    )
      throw Error('WINDOW_OPEN');
    closeCouncil(b);
    b.mode = input.present && b.turnMs > 0 && input.now < b.hardDeadlineAt ? 'LIVE' : 'RESERVED';
    b.deadlineAt = Math.min(b.hardDeadlineAt, input.now + (b.mode === 'LIVE' ? b.turnMs : 0));
    return state;
  }
  if (b.mode === 'LIVE' && input.now < b.deadlineAt) throw Error('WINDOW_OPEN');
  if (b.mode === 'LIVE' && input.now >= b.hardDeadlineAt) {
    for (const receipt of b.receipts.filter((r) => input.receipts?.some((v) => v.id === r.id))) {
      receipt.status = 'REJECTED';
      receipt.reason = 'TIME_LIMIT';
    }
    b.phase = 'ended';
    b.result = 'defend';
    b.reason = '직접 지휘 총 시간 상한: 공격 철수';
    recordBattleFrame(b, [{ kind: 'end', text: b.reason }]);
    settleTacticalBattle(state, b);
    return state;
  }
  const next = resolveBattleTurn(b, input.orders as BattleOrder[], unitSet);
  next.mode = input.present && next.turnMs > 0 ? 'LIVE' : 'RESERVED';
  next.deadlineAt = Math.min(next.hardDeadlineAt, input.now + (next.mode === 'LIVE' ? next.turnMs : 0));
  state.campaign!.tactical!.battles[state.campaign!.tactical!.battles.findIndex((v) => v.id === b.id)] = next;
  if (next.phase === 'ended') settleTacticalBattle(state, next);
  return state;
}
export const tacticalInputKinds: readonly InputKindDefinition[] = [
  ...['battle.plan', 'battle.council', 'battle.turn'].map((kind) => ({
    kind,
    feature: 'campaign-v1',
    route: 'queued' as const,
    apply(replay: Parameters<InputKindDefinition['apply']>[0], input: Parameters<InputKindDefinition['apply']>[1]) {
      const result = applyBattleInput(
        replay.state,
        kind,
        (input.payload as { input: unknown }).input,
        input.generalId!,
      );
      if (!result.ok || battleHash(result.result) !== battleHash(input.result))
        throw Error('전술 입력 재생 결과가 다릅니다.');
      return { ...replay, state: result.state };
    },
  })),
  {
    kind: 'battle.step',
    feature: 'campaign-v1',
    route: 'direct',
    apply(replay, input) {
      if (!replay.campaignUnitSet) throw Error('전술 병종 자원이 없습니다.');
      const state = applyBattleStep(replay.state, input.payload, replay.campaignUnitSet);
      const b = state.campaign!.tactical!.battles.find((b) => b.id === battleStepSchema.parse(input.payload).battleId)!;
      if (battleHash(input.result) !== battleHash({ hash: battleStateHash(b) }))
        throw Error('전술 턴 재생 결과가 다릅니다.');
      return { ...replay, state };
    },
  },
];
