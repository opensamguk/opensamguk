import type { CommandInfo } from './CommandPicker';

// 명령 도움말과 실행 가능 여부 (INT-26). commands.list는 설명·비용·요구 조건·소요 턴·가능 여부를 싣고,
// nationCommands.list는 가능 여부만 싣는다. 없는 값은 줄을 그리지 않는다.

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

export interface CommandDocText {
  description: string | null;
  cost: string | null;
  requirements: string[];
  turns: number | null;
}

export function commandDoc(command: CommandInfo): CommandDocText {
  return {
    description: text(command.description),
    cost: text(command.cost),
    requirements: (command.requirements ?? []).flatMap((item) => text(item) ?? []),
    turns: typeof command.turns === 'number' && command.turns > 0 ? command.turns : null,
  };
}

// 인자 화면 안내 줄의 요구 조건·소요 턴 글.
export const requirementsText = (requirements: readonly string[]) =>
  requirements.length > 0 ? `조건: ${requirements.join(' · ')}` : null;
export const turnsText = (turns: number | null) => (turns === null ? null : `소요 ${turns}턴`);

const UNAVAILABLE = '지금은 실행할 수 없습니다.';

// 명령 카드의 흐림과 사유. false만 흐리게 두고 사유를 적는다. 원작처럼 흐린 카드도 고르고 넣을 수 있다.
// null은 대상·값을 골라야 알 수 있다는 뜻이라 흐리지 않는다. 값이 없으면(옛 서버) 흐리지 않는다.
export function commandAvailability(command: Pick<CommandInfo, 'available' | 'reason'>): {
  dimmed: boolean;
  reason: string | null;
} {
  if (command.available !== false) return { dimmed: false, reason: null };
  return { dimmed: true, reason: text(command.reason) ?? UNAVAILABLE };
}
