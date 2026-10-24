import { z } from 'zod';
import { TREATY_INPUTS, validateTreatyState } from './diplomacy/treaty';
import type { TreatyState } from './diplomacy/treatyTypes';
import { isPolicyMode } from './policy';
import { policyFormatSchema, type PolicyFormat } from './policy/replay';
import {
  parseCapsOrigin,
  selectSupportedCapabilities,
  type CapsOrigin,
  type CapabilitySelection,
} from './replayCapabilities';

export interface WorldCapsRow {
  treatyFormat: number | null;
  personnelFormat: number | null;
  policyFromSequence: number | null;
  actionSequence: number;
  turnTermMinutes: number;
  endYear: number | null;
  outcomeFromSequence: number;
  replayOrigin: unknown;
}
export type WorldCapabilities =
  | { kind: 'legacy'; policy: PolicyFormat | null }
  | { kind: 'caps'; origin: CapsOrigin; selection: CapabilitySelection };

const storedInteger = z.number().int().min(0).max(2_147_483_647);
const positive = storedInteger.min(1);

// DB 타입이나 preset에 의존하지 않고 저장된 선택만 본다.
export function selectWorldCapabilities(row: WorldCapsRow): WorldCapabilities {
  const treatyFormat = z.literal(1).nullable().parse(row.treatyFormat);
  const personnelFormat = z.literal(1).nullable().parse(row.personnelFormat);
  const actionSequence = storedInteger.parse(row.actionSequence);
  const policy =
    row.policyFromSequence === null
      ? null
      : policyFormatSchema.parse({
          version: 1,
          fromSequence: row.policyFromSequence,
          turnTermMinutes: row.turnTermMinutes,
        });
  if (policy && !isPolicyMode({ fromSequence: policy.fromSequence, actionSequence }))
    throw new Error('저장된 방침 전환 순서를 확인하세요.');
  const origin = row.replayOrigin;
  if (
    origin === null ||
    (typeof origin === 'object' &&
      origin !== null &&
      !Array.isArray(origin) &&
      'version' in origin &&
      origin.version === 1)
  ) {
    if (treatyFormat !== null) throw new Error('조약 저장 형식과 생성 기록이 다릅니다.');
    if (personnelFormat !== null) throw new Error('인사 저장 형식과 생성 기록이 다릅니다.');
    return { kind: 'legacy', policy };
  }
  const parsed = parseCapsOrigin(origin);
  if (Object.hasOwn(parsed.capabilities, 'treaty') !== (treatyFormat === 1))
    throw new Error('조약 저장 형식과 생성 기록이 다릅니다.');
  if (Object.hasOwn(parsed.capabilities, 'personnel') !== (personnelFormat === 1))
    throw new Error('인사 저장 형식과 생성 기록이 다릅니다.');
  const selection = selectSupportedCapabilities(parsed, {
    endYear: row.endYear,
    outcomeFromSequence: row.outcomeFromSequence,
    ...(policy ? { policy } : {}),
  });
  return { kind: 'caps', origin: parsed, selection };
}

export interface TreatyStorageRow {
  id: number;
  fromNationId: number;
  toNationId: number;
  clauses: unknown;
  status: 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'ENDED';
  proposedTick: number;
  respondByTick: number;
  startTick: number | null;
  endTick: number | null;
  costFrom: number | null;
  costTo: number | null;
  closedSequence: number | null;
}
const storageSchema = z.strictObject({
  id: positive,
  fromNationId: positive,
  toNationId: positive,
  clauses: z.unknown(),
  status: z.enum(['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED']),
  proposedTick: storedInteger,
  respondByTick: storedInteger,
  startTick: storedInteger.nullable(),
  endTick: storedInteger.nullable(),
  costFrom: storedInteger.nullable(),
  costTo: storedInteger.nullable(),
  closedSequence: positive.nullable(),
});

// 서버가 worldId를 뺀 저장 행을 넘긴다. 비용·마감 기록은 상태에 싣지 않는다.
export function projectTreatyRows(rows: readonly unknown[]): TreatyState[] | undefined {
  const treaties: TreatyState[] = [];
  const ids = new Set<number>();
  for (const value of rows) {
    const row = storageSchema.parse(value);
    if (ids.has(row.id)) throw new Error('조약 저장 행의 ID가 겹칩니다.');
    ids.add(row.id);
    if (row.fromNationId === row.toNationId) throw new Error('조약 저장 행의 당사국을 확인하세요.');
    TREATY_INPUTS['treaty.propose'].payloadSchema.parse({ toNationId: row.toNationId, clauses: row.clauses });
    if (row.status !== 'PROPOSED' && row.status !== 'ACTIVE') {
      if (row.closedSequence === null) throw new Error('닫힌 조약에 마감 기록이 없습니다.');
      continue;
    }
    if (
      row.closedSequence !== null ||
      (row.status === 'PROPOSED' && (row.costFrom !== null || row.costTo !== null)) ||
      (row.status === 'ACTIVE' && (row.costFrom === null || row.costTo === null))
    )
      throw new Error('열린 조약의 납부·마감 기록을 확인하세요.');
    treaties.push(
      validateTreatyState({
        id: row.id,
        fromNationId: row.fromNationId,
        toNationId: row.toNationId,
        clauses: row.clauses,
        status: row.status,
        proposedTick: row.proposedTick,
        respondByTick: row.respondByTick,
        startTick: row.startTick,
        endTick: row.endTick,
      }),
    );
  }
  return treaties.length ? treaties.sort((a, b) => a.id - b.id) : undefined;
}
