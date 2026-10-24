import type { PolicyKey, PolicyOption, PolicyRejection, PolicyResponse } from './types';

// 방침 이름, 명령 이름, 미접속 날 수는 서버 응답(general.policy)에서만 온다. 화면에 방침 표나 날 수를 따로 두지 않는다 (T2-13).

// 받침이 있으면 '을', 없으면 '를'. 한글이 아니면 '을(를)'로 둔다.
export function objectParticle(word: string): string {
  const code = word.trim().at(-1)?.charCodeAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return '을(를)';
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
}

// 받침이 없거나 ㄹ 받침이면 '로', 나머지는 '으로'.
export function directionParticle(word: string): string {
  const code = word.trim().at(-1)?.charCodeAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return '(으)로';
  const final = (code - 0xac00) % 28;
  return final === 0 || final === 8 ? '로' : '으로';
}

export function findOption(policy: PolicyResponse | undefined, key: PolicyKey | null | undefined) {
  return key ? policy?.options.find((option) => option.key === key) : undefined;
}

// 고르기 칸의 값(문자열)을 서버가 준 방침 중 하나로 확인한다. 없는 값이면 보내지 않는다.
export function optionFor(policy: PolicyResponse, value: string): PolicyOption | undefined {
  return policy.options.find((option) => option.key === value);
}

// 예턴 편집 위 한 줄. 방침이 none이면 빈 칸은 그냥 휴식한다.
export function policySentence(option: PolicyOption | undefined): string {
  if (!option || option.key === 'none') return '빈 칸은 휴식합니다.';
  const first = option.emptyCommand.name;
  const then = option.thenCommand
    ? ` 이미 최대면 ${option.thenCommand.name}${objectParticle(option.thenCommand.name)} 합니다.`
    : '';
  return `빈 칸은 ${first}${objectParticle(first)} 합니다.${then} 실패하면 휴식합니다.`;
}

// 장기 미접속 안내 (U63-1·U63-2). 미접속이어도 실행은 바뀌지 않으므로 내 활동 시각이나 남은 날 수는 적지 않는다.
export function inactiveSentence(policy: PolicyResponse): string {
  return `정지한 시간을 빼고 월드 시간으로 ${policy.inactiveAfterDays}일 넘게 들어오지 않아도 직접 넣은 명령과 휴식은 그대로 하고 빈 칸만 기본 방침대로 합니다.`;
}

// 엔진의 방침 입력 거절 코드(apps/engine/src/inputs.ts)를 엔진 문장으로 옮긴다. 코드는 화면에 그대로 보이지 않는다.
const REJECTION_TEXT: Record<string, string> = {
  WORLD_CLOSED: '종료된 월드입니다.',
  ACTOR_INACTIVE: '활성 계정이 아닙니다.',
  NO_GENERAL: '내 장수가 아닙니다.',
  BAD_POLICY: '활동·기본 방침 입력이 올바르지 않습니다.',
};

// 거절 안내 한 줄. 모르는 코드면 일반 실패 문장만 둔다.
export function rejectionSentence(policy: PolicyResponse, rejected: PolicyRejection): string {
  const reason = Object.hasOwn(REJECTION_TEXT, rejected.reason) ? REJECTION_TEXT[rejected.reason] : undefined;
  if (reason === undefined) return '방침을 바꾸지 못했습니다.';
  const name = findOption(policy, rejected.policy)?.name;
  return name
    ? `${name}${directionParticle(name)} 바꾸지 못했습니다. ${reason}`
    : `방침을 바꾸지 못했습니다. ${reason}`;
}

// 편집기의 빈 칸 표시. 지금 확정된 방침(current)을 따른다. 방침을 모르거나 none이면 빈 칸 휴식이다.
export function emptySlotLabel(policy: PolicyResponse | undefined): { tag: string; command: string } {
  const option = findOption(policy, policy?.current);
  if (!option || option.key === 'none') return { tag: '빈 칸', command: '휴식' };
  return { tag: option.name, command: option.emptyCommand.name };
}
