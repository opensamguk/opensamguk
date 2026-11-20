// 명령 제안(상신) 서버 응답을 목록 부품 형식으로 바꾼다 (D-100).
// 서버 칸 번호는 국가 예턴 0~11이고 화면은 1~12로 보인다. 상태는 서버 열거를 화면 상태로 옮긴다.
import { describeArgs, type ArgNames } from '../turns/args';
import type { ProposalItem, ProposalStatus } from './ProposalList';

// 서버 proposals.list 한 줄(apps/server/src/game/proposals.ts listProposals). 라우터 전체 추론은 타입 검사를 너무 깊게
// 만들어 필요한 칸만 적는다. 서버 응답이 이 형태에 맞지 않으면 쓰는 쪽(ProposalBox)의 타입 검사가 실패한다.
export interface ServerProposal {
  id: string;
  proposer: ProposalItem['proposer'];
  commandKey: string;
  commandName: string;
  args: unknown;
  slot: number | null;
  note: string | null;
  // 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED' (rules proposalStatus). 서버 타입은 문자열이다.
  status: string;
  createdTick: number;
  expiresTick: number;
  precheck: { ok: boolean; message: string | null } | null;
  response: { by: number; at: number | null; reason: string | null } | null;
}

const STATUS: Record<string, ProposalStatus | undefined> = {
  PENDING: 'open',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

// 화면 칸 번호(1~12)와 서버 칸 번호(0~11).
export const toServerSlot = (slot: number) => slot - 1;

// 답한 장수는 서버가 번호(responseBy)로 준다. 이름을 모르면 번호로 적는다.
export function toProposalItem(
  row: ServerProposal,
  names: ArgNames,
  generalName: (id: number) => string | undefined,
): ProposalItem {
  const args = row.args !== null && typeof row.args === 'object' ? (row.args as Record<string, unknown>) : {};
  return {
    id: row.id,
    proposer: row.proposer,
    commandKey: row.commandKey,
    commandName: row.commandName,
    argsSummary: describeArgs(args, names),
    slot: row.slot === null ? null : row.slot + 1,
    note: row.note ?? '',
    // 모르는 상태는 닫힌 제안으로 보인다. 답하기 단추가 열리지 않는다.
    status: STATUS[row.status] ?? 'expired',
    createdTick: row.createdTick,
    expiresTick: row.expiresTick,
    precheck: row.precheck ? { ok: row.precheck.ok, message: row.precheck.message ?? '' } : null,
    response: row.response
      ? {
          by: generalName(row.response.by) ?? `장수 ${row.response.by}`,
          at: row.response.at ?? 0,
          reason: row.response.reason,
        }
      : null,
  };
}
