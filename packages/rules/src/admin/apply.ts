import { isLocalOffice } from '../personnel/residentOffice';
import { z } from 'zod';
import type { JsonValue } from '../model/world';
import type { RecordedInput, ReplayState } from '../replay';
import type { UnitSetResource } from '../world/resources';
import { lineageAlive } from '../lineage/eligibility';
import { isAppointableOfficerLevel } from '../personnel/permissions';
import { emptyQueue } from '../policy';
import { emptyTurns } from '../replayInputs';
import { removeAdminGeneral } from './remove';
import { applyAdminNation } from './nation';
import {
  adminGamePayloadSchema,
  adminGameRejectMessages,
  isAdminGameKind,
  type AdminGameAction,
  type AdminGameRejectCode,
} from './game';

const counter = z.number().int().min(0).max(2_147_483_647);
const legacyTurn = z.strictObject({ commandKey: z.string().min(1), args: z.json() });
const turn = z.union([legacyTurn, legacyTurn.extend({ explicit: z.boolean() })]);
export const adminGameRejectedSchema = z
  .strictObject({
    code: z.enum(Object.keys(adminGameRejectMessages) as [AdminGameRejectCode, ...AdminGameRejectCode[]]),
    message: z.string(),
  })
  .refine((result) => adminGameRejectMessages[result.code] === result.message);

function snapshotSchema(action: AdminGameAction): z.ZodType<JsonValue> {
  switch (action.kind) {
    case 'admin.message.send':
      return z.strictObject({ sent: z.boolean() });
    case 'admin.general.rename':
    case 'admin.nation.rename':
      return z.strictObject({ name: z.string().min(1) });
    case 'admin.general.release':
      return z.strictObject({ userId: z.string().min(1).nullable(), nationIsNpc: z.boolean().nullable() });
    case 'admin.general.clearTurns':
      return z.strictObject({ revision: counter, turns: z.array(turn).length(30) });
    case 'admin.general.remove':
      return z.strictObject({
        userId: z.string().min(1).nullable(),
        nationId: counter.nullable(),
        officerLevel: counter,
        crew: counter,
        removedAt: counter.nullable(),
      });
    case 'admin.nation.dismissOffice':
      return z.strictObject({ officerLevel: counter });
    case 'admin.nation.setRuler':
      return z.strictObject({ rulerId: counter.min(1), previousRulerExperience: counter, nationIsNpc: z.boolean() });
    case 'admin.nation.disband':
      return z.strictObject({ exists: z.boolean(), members: counter, cities: counter });
    default:
      return z.strictObject(
        Object.fromEntries(
          Object.entries(action.changes)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => [
              key,
              key === 'trust' || key === 'tech'
                ? z
                    .number()
                    .min(0)
                    .max(key === 'trust' ? 100 : 12000)
                : counter,
            ]),
        ),
      );
  }
}

export function adminGameAppliedSchema(action: AdminGameAction) {
  const snapshot = snapshotSchema(action);
  return z.strictObject({ version: z.literal(1), before: snapshot, after: snapshot });
}
export type AdminGameApplied = z.infer<ReturnType<typeof adminGameAppliedSchema>>;
export type AdminGameOutcome =
  | { status: 'REJECTED'; result: z.infer<typeof adminGameRejectedSchema>; replay: ReplayState }
  | { status: 'APPLIED'; result: AdminGameApplied; replay: ReplayState };
export interface AdminGameContext {
  userActive: boolean;
  admin: boolean;
  sanctioned: boolean;
  replayFormat: number;
  worldStatus: string;
  unitSet?: UnitSetResource;
  tick?: number;
}

// 같은 칸의 expected를 전부 확인한 뒤에만 사본을 바꾼다.
export function decideAdminGameAction(
  replay: ReplayState,
  payload: unknown,
  context: AdminGameContext,
): AdminGameOutcome {
  const reject = (code: AdminGameRejectCode): AdminGameOutcome => ({
    status: 'REJECTED',
    result: { code, message: adminGameRejectMessages[code] },
    replay,
  });
  if (!context.userActive) return reject('ACTOR_INACTIVE');
  if (!context.admin) return reject('ADMIN_REQUIRED');
  if (context.sanctioned) return reject('ACTOR_SANCTIONED');
  if (context.replayFormat !== 3) return reject('UNSUPPORTED_FORMAT');
  if (!['RUNNING', 'PAUSED'].includes(context.worldStatus)) return reject('WORLD_STATE_CHANGED');
  const parsed = adminGamePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject('INVALID_VALUE');
  const action = parsed.data.action;
  const general =
    'generalId' in action && action.generalId !== undefined ? replay.state.generals[action.generalId] : undefined;
  const nation = 'nationId' in action ? replay.state.nations[action.nationId] : undefined;
  const city = 'cityKey' in action ? replay.state.cities[action.cityKey] : undefined;
  if (
    ('generalId' in action &&
      action.generalId !== undefined &&
      (!general || !lineageAlive(replay.state, action.generalId))) ||
    ('nationId' in action && !nation) ||
    ('cityKey' in action && !city)
  )
    return reject('TARGET_MISSING');

  let before: JsonValue;
  let after: JsonValue;
  const next = structuredClone(replay);
  switch (action.kind) {
    case 'admin.message.send': {
      before = { sent: false };
      after = { sent: true };
      break;
    }
    case 'admin.general.remove': {
      if (general!.officerLevel === 12) return reject('INVALID_VALUE');
      if (!Number.isInteger(context.tick) || context.tick! < 0 || context.tick! > 2_147_483_647)
        throw Error('장수 내보내기의 처리 tick이 없습니다.');
      const snapshot = (g: typeof general) => ({
        userId: g!.userId,
        nationId: g!.nationId,
        officerLevel: g!.officerLevel,
        crew: g!.crew,
        removedAt: g!.removedAt ?? null,
      });
      before = snapshot(general);
      if (!removeAdminGeneral(next, action.generalId, context.tick!)) return reject('INVALID_VALUE');
      after = snapshot(next.state.generals[action.generalId]);
      break;
    }
    case 'admin.general.rename': {
      if (
        Object.values(replay.state.generals).some(
          (g) => g.id !== action.generalId && g.name.normalize('NFC').trim() === action.name,
        )
      )
        return reject('INVALID_VALUE');
      before = { name: general!.name };
      next.state.generals[action.generalId]!.name = action.name;
      after = { name: action.name };
      break;
    }
    case 'admin.general.release': {
      if (general!.userId === null) return reject('INVALID_VALUE');
      const rulerNation = general!.officerLevel === 12 ? next.state.nations[general!.nationId!] : undefined;
      before = { userId: general!.userId, nationIsNpc: rulerNation?.isNpc ?? null };
      next.state.generals[action.generalId]!.userId = null;
      if (rulerNation) rulerNation.isNpc = true;
      if (next.policy) delete next.policy.lastActiveTicks[action.generalId];
      after = { userId: null, nationIsNpc: rulerNation?.isNpc ?? null };
      break;
    }
    case 'admin.general.clearTurns': {
      const revision = replay.revisions[action.generalId];
      if (revision === undefined || revision >= 2_147_483_647) return reject('INVALID_VALUE');
      const turns = replay.turns[action.generalId];
      if (!turns || turns.length !== 30) throw Error('장수의 예턴 30칸이 없습니다.');
      next.turns[action.generalId] = replay.policy ? emptyQueue() : emptyTurns();
      next.revisions[action.generalId] = revision + 1;
      before = { revision, turns: z.array(turn).parse(turns) };
      after = { revision: revision + 1, turns: z.array(turn).parse(next.turns[action.generalId]) };
      break;
    }
    case 'admin.nation.rename': {
      if (Object.values(replay.state.nations).some((n) => n.id !== action.nationId && n.name === action.name))
        return reject('INVALID_VALUE');
      before = { name: nation!.name };
      next.state.nations[action.nationId]!.name = action.name;
      after = { name: action.name };
      break;
    }
    case 'admin.nation.dismissOffice': {
      if (
        general!.nationId !== action.nationId ||
        (!isAppointableOfficerLevel(general!.officerLevel) &&
          !(replay.state.officeEffects && isLocalOffice(general!.officerLevel) && general!.officerCityKey != null))
      )
        return reject('INVALID_VALUE');
      before = { officerLevel: general!.officerLevel };
      next.state.generals[action.generalId]!.officerLevel = 1;
      delete next.state.generals[action.generalId]!.officerCityKey;
      after = { officerLevel: 1 };
      break;
    }
    case 'admin.nation.setRuler':
    case 'admin.nation.disband': {
      if (!Number.isInteger(context.tick) || context.tick! < 0 || context.tick! > 2_147_483_647)
        throw Error('국가 운영 조치의 처리 tick이 없습니다.');
      const code = applyAdminNation(next, action, context.tick!);
      if (code) return reject(code);
      if (action.kind === 'admin.nation.setRuler') {
        before = {
          rulerId: action.expectedRulerId,
          previousRulerExperience: replay.state.generals[action.expectedRulerId]!.experience,
          nationIsNpc: nation!.isNpc,
        };
        after = {
          rulerId: action.generalId,
          previousRulerExperience: next.state.generals[action.expectedRulerId]!.experience,
          nationIsNpc: next.state.nations[action.nationId]!.isNpc,
        };
      } else {
        before = {
          exists: true,
          members: Object.values(replay.state.generals).filter((row) => row.nationId === action.nationId).length,
          cities: Object.values(replay.state.cities).filter((row) => row.nationId === action.nationId).length,
        };
        after = { exists: false, members: 0, cities: 0 };
      }
      break;
    }
    default: {
      const target =
        action.kind === 'admin.general.adjust' ? general! : action.kind === 'admin.city.adjust' ? city! : nation!;
      const changed = Object.entries(action.changes).filter(
        (entry): entry is [string, { expected: number; value: number }] => entry[1] !== undefined,
      );
      const values = target as unknown as Record<string, number>;
      if (changed.some(([field, value]) => values[field] !== value.expected)) return reject('TARGET_CHANGED');
      if (
        action.kind === 'admin.general.adjust' &&
        replay.state.ruleFeatures?.includes('campaign-v1') &&
        ['crew', 'crewType', 'train', 'atmos'].some((key) => Object.hasOwn(action.changes, key))
      )
        return reject('CAMPAIGN_FIELD');
      if (action.kind === 'admin.general.adjust') {
        if (action.changes.cityKey && !replay.state.cities[action.changes.cityKey.value])
          return reject('INVALID_VALUE');
        if (action.changes.crewType) {
          if (!context.unitSet) throw Error('관리자 병종 조정의 원생성 병종표가 없습니다.');
          if (
            !context.unitSet.crewTypes.some((unit) => unit.id === action.changes.crewType!.value && unit.armType !== 0)
          )
            return reject('INVALID_VALUE');
        }
      }
      if (action.kind === 'admin.city.adjust') {
        const bounds = {
          population: city!.populationMax,
          agriculture: city!.agricultureMax,
          commerce: city!.commerceMax,
          security: city!.securityMax,
          defence: city!.defenceMax,
          wall: city!.wallMax,
          trust: 100,
        };
        for (const [field, value] of Object.entries(action.changes))
          if (value && value.value > bounds[field as keyof typeof bounds]) return reject('INVALID_VALUE');
      }
      before = Object.fromEntries(changed.map(([field]) => [field, values[field]!]));
      after = Object.fromEntries(changed.map(([field, value]) => [field, value.value]));
      if (action.kind === 'admin.general.adjust') Object.assign(next.state.generals[action.generalId]!, after);
      else if (action.kind === 'admin.city.adjust') Object.assign(next.state.cities[action.cityKey]!, after);
      else Object.assign(next.state.nations[action.nationId]!, after);
    }
  }
  return {
    status: 'APPLIED',
    result: adminGameAppliedSchema(action).parse({ version: 1, before, after }),
    replay: next,
  };
}

export function validateAdminGameRecord(input: RecordedInput): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    !isAdminGameKind(input.kind) ||
    input.generalId !== null
  )
    throw Error('관리자 게임 입력 기록을 확인하세요.');
  counter.min(1).parse(input.sequence);
  counter.parse(input.tick);
  const payload = adminGamePayloadSchema.parse(input.payload);
  if (payload.action.kind !== input.kind) throw Error('관리자 게임 입력 종류와 조치가 다릅니다.');
  if (input.status === 'REJECTED') adminGameRejectedSchema.parse(input.result);
  else if (input.status === 'APPLIED') adminGameAppliedSchema(payload.action).parse(input.result);
  else throw Error('완료된 관리자 게임 입력이 필요합니다.');
}

export function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]!))
    );
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key]!, b[key]!))
  );
}

export function applyAdminGameRecord(
  replay: ReplayState,
  input: RecordedInput,
  context?: { unitSet?: UnitSetResource },
): ReplayState {
  validateAdminGameRecord(input);
  if (input.status === 'REJECTED') return replay;
  const outcome = decideAdminGameAction(replay, input.payload, {
    userActive: true,
    admin: true,
    sanctioned: false,
    replayFormat: 3,
    worldStatus: 'RUNNING',
    tick: input.tick!,
    ...context,
  });
  if (outcome.status !== 'APPLIED' || !sameJson(outcome.result, input.result as JsonValue))
    throw Error('관리자 게임 조치의 변경 전후 값이 재생과 다릅니다.');
  return outcome.replay;
}
