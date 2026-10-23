import type { PolicyKey, PolicyOption, PolicyResponse } from './contract';

// 방침 이름과 명령 이름은 서버 응답(PolicyResponse.options)에서만 온다. 화면에 방침 표를 따로 두지 않는다 (T2-13).

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

// 예턴 편집 위 한 줄. 방침이 none이면 빈 칸은 그냥 휴식한다.
export function policySentence(option: PolicyOption | undefined): string {
  if (!option || option.key === 'none') return '빈 칸은 휴식합니다.';
  const first = option.emptyCommand.name;
  const then = option.thenCommand
    ? ` 이미 최대면 ${option.thenCommand.name}${objectParticle(option.thenCommand.name)} 합니다.`
    : '';
  return `빈 칸은 ${first}${objectParticle(first)} 합니다.${then} 실패하면 휴식합니다.`;
}

// 편집기의 빈 칸 표시. 지금 확정된 방침(current)을 따른다. 방침을 모르거나 none이면 빈 칸 휴식이다.
export function emptySlotLabel(policy: PolicyResponse | undefined): { tag: string; command: string } {
  const option = findOption(policy, policy?.current);
  if (!option || option.key === 'none') return { tag: '빈 칸', command: '휴식' };
  return { tag: option.name, command: option.emptyCommand.name };
}
