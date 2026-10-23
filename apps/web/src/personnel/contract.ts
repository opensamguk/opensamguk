import { createContext, useContext } from 'react';
import { trpcClient } from '../trpc';

// 임시 계약. 기준은 docs/plans/T2-05.md의 "즉시 행동의 접수와 완료"와 "API 계약" 절이다.
// Codex API(T2-05)가 main에 들어오면 이 파일을 지우고 `AppRouter` 타입(useTRPC의 personnel·offers·nationTurns·nationCommands)으로 바꾼다.
// 그때까지 같은 경로의 tRPC 프로시저를 이름으로 부른다. 화면은 이 파일의 타입과 PersonnelApi만 쓴다.

export type Allowed = { ok: true } | { ok: false; reason: string };
export type CityRef = { cityKey: number; name: string };
export type DisplaySlot = { commandKey: string; args?: unknown; name: string };

export interface PersonnelBoard {
  appoint: Allowed;
  levels: Array<{ officerLevel: number; title: string; holderId: number | null }>;
  members: PersonnelMember[];
}

export interface PersonnelMember {
  generalId: number;
  name: string;
  officerLevel: number;
  title: string;
  isHuman: boolean;
  city: CityRef;
  dedication: number;
}

export interface Office {
  nationId: number;
  officerLevel: number;
  tenure: number;
}

export interface NationTurnTab {
  office: Office;
  officerLevel: number;
  title: string;
  holder: { generalId: number; name: string } | null;
  edit: Allowed;
  revision: number;
  slots: DisplaySlot[];
}

export type NationTurnSave =
  | { ok: true; revision: number; slots: DisplaySlot[] }
  | { ok: false; reason: 'STALE'; revision: number; slots: DisplaySlot[] };

export interface NationCommand {
  key: string;
  name: string;
  argsSchema: unknown;
}

export interface AssignmentOfferView {
  id: string;
  issuer: { generalId: number; name: string };
  targetCity: CityRef;
  expires: { year: number; month: number; monthsLeft: number };
  rejectCost: { dedicationPercent: number; dedication: number };
  respond: Allowed;
}

export type RequestState<R> =
  | { status: 'pending'; requestId: string }
  | { status: 'applied'; requestId: string; result: R }
  | { status: 'rejected'; requestId: string; code: string; message: string };

export type PersonnelKind = 'personnel.appoint' | 'personnel.dismiss' | 'offer.respond';
export type AppointResult = { generalId: number; officerLevel: number; title: string };
export type RespondResult = { offerStatus: 'ACCEPTED' | 'REJECTED'; city: CityRef; dedicationLost: number };
export type PersonnelResult = AppointResult | RespondResult;
export type PersonnelRecord = { kind: PersonnelKind; state: RequestState<PersonnelResult> };

type W = { worldId: string };

// 즉시 행동 셋의 요청. requestId는 화면이 만들고 재전송 때 그대로 쓴다.
export type ActionInput =
  | { kind: 'personnel.appoint'; generalId: number; officerLevel: number }
  | { kind: 'personnel.dismiss'; generalId: number }
  | { kind: 'offer.respond'; offerId: string; accept: boolean };

export interface PersonnelApi {
  officers(input: W): Promise<PersonnelBoard>;
  act(input: W & { requestId: string; action: ActionInput }): Promise<RequestState<PersonnelResult>>;
  request(input: W & { requestId: string }): Promise<PersonnelRecord>;
  recent(input: W): Promise<PersonnelRecord[]>;
  offers(input: W): Promise<AssignmentOfferView[]>;
  nationTurns(input: W): Promise<{ tabs: NationTurnTab[] }>;
  setNationTurns(
    input: W & {
      office: Office;
      revision: number;
      slots: Array<{ commandKey: string; args: Record<string, unknown> } | null>;
    },
  ): Promise<NationTurnSave>;
  nationCommands(input: W): Promise<NationCommand[]>;
  precheckNation(input: W & { commandKey: string; args: Record<string, unknown> }): Promise<Allowed>;
}

type Procedure = { query: (input: unknown) => Promise<unknown>; mutate: (input: unknown) => Promise<unknown> };
type Untyped = Record<string, Record<string, Procedure>>;

export function makePersonnelApi(client: unknown = trpcClient): PersonnelApi {
  const c = client as Untyped;
  const q = <T>(router: string, name: string, input: unknown) => c[router]![name]!.query(input) as Promise<T>;
  const m = <T>(router: string, name: string, input: unknown) => c[router]![name]!.mutate(input) as Promise<T>;
  return {
    officers: (input) => q('personnel', 'officers', input),
    act: ({ worldId, requestId, action }) => {
      const { kind, ...rest } = action;
      if (kind === 'offer.respond') return m('offers', 'respond', { worldId, requestId, ...rest });
      return m('personnel', kind === 'personnel.appoint' ? 'appoint' : 'dismiss', { worldId, requestId, ...rest });
    },
    request: (input) => q('personnel', 'request', input),
    recent: (input) => q('personnel', 'recent', input),
    offers: (input) => q('offers', 'mine', input),
    nationTurns: (input) => q('nationTurns', 'get', input),
    setNationTurns: (input) => m('nationTurns', 'set', input),
    nationCommands: (input) => q('nationCommands', 'list', input),
    precheckNation: (input) => q('nationCommands', 'precheck', input),
  };
}

// 화면이 쓰는 조회 키. tRPC tanstack 키 모양([[라우터, 프로시저], { input, type }])으로 맞춰 둔다.
// AppRouter로 바꾸면 trpc.<라우터>.<프로시저>.queryKey와 같은 키라 무효화가 그대로 맞는다.
const key = (path: [string, string], input?: Record<string, unknown>) =>
  (input === undefined ? [path] : [path, { input, type: 'query' }]) as readonly unknown[];

export const personnelKeys = {
  officers: (worldId: string) => key(['personnel', 'officers'], { worldId }),
  request: (worldId: string, requestId: string) => key(['personnel', 'request'], { worldId, requestId }),
  recent: (worldId: string) => key(['personnel', 'recent'], { worldId }),
  offers: (worldId: string) => key(['offers', 'mine'], { worldId }),
  nationTurns: (worldId: string) => key(['nationTurns', 'get'], { worldId }),
  nationCommands: (worldId: string) => key(['nationCommands', 'list'], { worldId }),
  precheckRoot: key(['nationCommands', 'precheck']),
  precheck: (worldId: string, commandKey: string, args: Record<string, unknown>) =>
    key(['nationCommands', 'precheck'], { worldId, commandKey, args }),
};

// 시험은 가짜 API를 넣는다. 화면은 기본값(실제 tRPC 클라이언트)을 쓴다.
export const PersonnelApiContext = createContext<PersonnelApi | null>(null);
let defaultApi: PersonnelApi | undefined;
export function usePersonnelApi(): PersonnelApi {
  return useContext(PersonnelApiContext) ?? (defaultApi ??= makePersonnelApi());
}
