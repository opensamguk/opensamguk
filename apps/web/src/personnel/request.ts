import { errorCode, serverMessage } from '../turns/apiError';
import type {
  ActionInput,
  AppointResult,
  PersonnelApi,
  PersonnelKind,
  PersonnelRecord,
  PersonnelResult,
  RequestState,
  RespondResult,
} from './contract';

// 즉시 행동(임명·해임·발령 응답)의 접수와 완료 대기. 순서는 docs/plans/T2-06.md "접수와 완료 대기" 절이다.
// 서버는 접수만 하고 엔진이 끝낸다. 화면은 requestId 결과로만 안내를 만든다.

export type SendOutcome =
  | { type: 'state'; state: RequestState<PersonnelResult> }
  | { type: 'error'; code: string; message: string }
  // 두 번 보내도 답을 못 받았다. 접수됐는지 모르므로 personnel.request로 확인한다.
  | { type: 'lost' };

// 응답을 못 받으면(연결 실패·시간 초과) 같은 requestId로 한 번 더 보낸다. 서버는 같은 접수의 지금 상태를 돌려준다.
export async function sendAction(
  api: PersonnelApi,
  worldId: string,
  requestId: string,
  action: ActionInput,
): Promise<SendOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { type: 'state', state: await api.act({ worldId, requestId, action }) };
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined)
        return { type: 'error', code, message: serverMessage(error) ?? '요청을 처리하지 못했습니다.' };
    }
  }
  return { type: 'lost' };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

// 이 브라우저에서 이미 안내한 requestId. 계정·월드별 localStorage 키에 둔다.
// 저장소를 못 쓰면 같은 안내를 한 번 더 볼 뿐 결과는 같다.
const ANNOUNCED_PREFIX = 'opensamguk.personnelAnnounced.v1';
const ANNOUNCED_LIMIT = 20;

export const announcedKey = (userId: string, worldId: string) => `${ANNOUNCED_PREFIX}:${userId}:${worldId}`;

export function readAnnounced(storage: Storage | undefined, key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function markAnnounced(storage: Storage | undefined, key: string, requestId: string) {
  try {
    const ids = readAnnounced(storage, key).filter((id) => id !== requestId);
    storage?.setItem(key, JSON.stringify([...ids, requestId].slice(-ANNOUNCED_LIMIT)));
  } catch {
    // 저장소가 막혀 있어도 안내는 계속한다.
  }
}

export interface Recovery {
  // 아직 끝나지 않은 접수. 대기를 잇는다.
  pending: PersonnelRecord | null;
  // 끝났지만 이 브라우저에서 아직 안내하지 않은 접수. 오래된 것부터.
  unannounced: PersonnelRecord[];
}

// personnel.recent(최신 순)에서 이 화면이 맡은 종류만 고른다.
export function recover(records: PersonnelRecord[], kinds: readonly PersonnelKind[], announced: string[]): Recovery {
  const mine = records.filter((record) => kinds.includes(record.kind));
  return {
    pending: mine.find((record) => record.state.status === 'pending') ?? null,
    unannounced: mine
      .filter((record) => record.state.status !== 'pending' && !announced.includes(record.state.requestId))
      .reverse(),
  };
}

// 받침이 있으면 withFinal, 없으면 withoutFinal. 한글이 아니면 unknown. ㄹ 받침 뒤 (으)로는 로다.
function josa(word: string, withFinal: string, withoutFinal: string, unknown: string, rieulAsNone = false): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return unknown;
  const final = code % 28;
  return final === 0 || (rieulAsNone && final === 8) ? withoutFinal : withFinal;
}
export const iGa = (word: string) => `${word}${josa(word, '이', '가', '이(가)')}`;
export const euro = (word: string) => `${word}${josa(word, '으로', '로', '(으)로', true)}`;

export function isRespondResult(result: PersonnelResult): result is RespondResult {
  return 'offerStatus' in result;
}

export interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

// 결과 안내. 제안 상자가 사라진 것으로 성공을 추측하지 않고 requestId의 결과로만 만든다.
export function noticeFor(
  kind: PersonnelKind,
  state: RequestState<PersonnelResult>,
  nameOf: (generalId: number) => string | undefined,
): Notice | null {
  if (state.status === 'pending') return null;
  if (state.status === 'rejected') return { tone: 'error', text: state.message };
  const result = state.result;
  if (kind === 'offer.respond' && isRespondResult(result)) {
    if (result.offerStatus === 'ACCEPTED')
      return { tone: 'ok', text: `발령을 수락해 ${euro(result.city.name)} 옮겼습니다.` };
    return { tone: 'ok', text: `발령을 거절했습니다. 공헌이 ${result.dedicationLost} 줄었습니다.` };
  }
  const appointed = result as AppointResult;
  const name = nameOf(appointed.generalId) ?? `장수 ${appointed.generalId}`;
  return { tone: 'ok', text: `${name}의 직책을 ${euro(appointed.title)} 바꿨습니다.` };
}
