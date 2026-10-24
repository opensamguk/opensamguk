export type TreatyClause =
  | { kind: 'peace' }
  | { kind: 'nonAggression'; months: number }
  | { kind: 'passage'; cityKeys: number[] }
  | { kind: 'tribute'; payerNationId: number; gold: number; rice: number; months: number }
  | { kind: 'trade'; months: number }
  | { kind: 'cityTransfer'; cityKey: number; giverNationId: number }
  | { kind: 'note'; text: string };

export type FirstTreatyClause = Extract<TreatyClause, { kind: 'peace' | 'nonAggression' | 'note' }>;

export interface TreatyState {
  id: number;
  fromNationId: number;
  toNationId: number;
  clauses: FirstTreatyClause[];
  status: 'PROPOSED' | 'ACTIVE';
  proposedTick: number;
  respondByTick: number;
  startTick: number | null;
  endTick: number | null;
}

export interface ClosedTreatyRow {
  id: number;
  fromNationId: number;
  toNationId: number;
  clauses: FirstTreatyClause[];
  status: 'REJECTED' | 'EXPIRED' | 'ENDED';
  proposedTick: number;
  respondByTick: number;
  startTick: number | null;
  endTick: number | null;
  costFrom: number | null;
  costTo: number | null;
  closedSequence: number;
}

export interface BrokenTreatyRow extends Omit<ClosedTreatyRow, 'status' | 'startTick' | 'costFrom' | 'costTo'> {
  status: 'BROKEN';
  startTick: number;
  costFrom: number;
  costTo: number;
}

export interface NationTrustState {
  nationId: number;
  brokenTreaties: number;
  lastBrokenTick: number;
}

export type TreatyBreakRejectCode =
  'WORLD_CLOSED' | 'ACTOR_INACTIVE' | 'NO_GENERAL' | 'NO_PERMISSION' | 'BAD_TARGET' | 'NOT_PARTY' | 'TREATY_NOT_ACTIVE';

export type TreatyBroken = {
  outcome: 'BROKEN';
  tick: number;
  treatyId: string;
  brokenByNationId: number;
};

export type TreatyInput =
  | { kind: 'treaty.propose'; payload: { toNationId: number; clauses: TreatyClause[] } }
  | { kind: 'treaty.respond'; payload: { treatyId: string; accept: boolean } };

export type TreatyApplied =
  | { outcome: 'PROPOSED'; tick: number; treatyId: string; respondByTick: number }
  | {
      outcome: 'ACCEPTED';
      by: 'HUMAN' | 'NPC';
      tick: number;
      treatyId: string;
      cost: { from: number; to: number };
      endTick: number | null;
    }
  | { outcome: 'DECLINED'; by: 'HUMAN' | 'NPC'; tick: number; treatyId: string };

export type TreatyRejectCode =
  | 'WORLD_CLOSED'
  | 'ACTOR_INACTIVE'
  | 'NO_GENERAL'
  | 'BAD_INPUT'
  | 'CLAUSE_NOT_CONNECTED'
  | 'NO_PERMISSION'
  | 'BAD_TARGET'
  | 'NOT_PARTY'
  | 'TREATY_NOT_PROPOSED'
  | 'EXPIRED'
  | 'TREATY_RELATION'
  | 'INSUFFICIENT_GOLD'
  | 'COUNTERPART_UNAVAILABLE';

export interface TreatyRejected {
  tick: number;
  code: TreatyRejectCode;
  message: string;
}

export type TreatyRecord = TreatyInput & {
  sequence: number;
  generalId: number;
} & ({ status: 'APPLIED'; result: TreatyApplied } | { status: 'REJECTED'; result: TreatyRejected });

// 형식 6 외피를 검사한 호출자가 선택된 정적 조약 capability를 넘긴다.
export interface TreatyRecordContext {
  treaty: { version: number } | null;
  monthlyTick: number;
  endTick?: number;
}

export interface TreatyClosure {
  id: number;
  status: 'EXPIRED' | 'ENDED';
}

export type TreatyApplyResult<State> =
  { ok: true; state: State; result: TreatyApplied } | { ok: false; result: TreatyRejected };
