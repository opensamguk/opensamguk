import type { Rng } from '@opensamguk/shared';
import type { ReputationKind } from './schema';

const subject = (name: string) => {
  const code = [...name].at(-1)?.charCodeAt(0) ?? 0;
  return name + (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '이' : '가');
};
type PublicSubject = { name: string; city: string | null };
export const REPUTATION_LINES: Record<ReputationKind, readonly ((value: PublicSubject) => string)[]> = {
  conquest: [
    ({ name, city }) => `${subject(name)} ${city} 점령을 이끌었다.`,
    ({ name, city }) => `${name}의 ${city} 점령이 기록에 올랐다.`,
    ({ name, city }) => `${city}의 주인이 바뀐 싸움에 ${name}의 이름이 남았다.`,
  ],
  victory: [
    ({ name }) => `${subject(name)} 교전에서 상대 장수를 물리쳤다.`,
    ({ name }) => `${name}의 승전이 이번 달 기록에 올랐다.`,
    ({ name }) => `${name}의 교전이 승리로 끝났다.`,
  ],
  domestic: [
    ({ name }) => `${subject(name)} 내정 목표를 채웠다.`,
    ({ name }) => `${name}의 내정 성과가 기록에 올랐다.`,
    ({ name }) => `${subject(name)} 맡은 내정 수치를 최대치까지 올렸다.`,
  ],
  defeat: [
    ({ name }) => `${subject(name)} 교전에서 패했다.`,
    ({ name }) => `${name}의 패전이 이번 달 기록에 남았다.`,
    ({ name }) => `${subject(name)} 교전에서 상대 장수를 막지 못했다.`,
  ],
  betrayal: [
    ({ name }) => `${subject(name)} 소속이나 조약의 약속을 끊었다.`,
    ({ name }) => `${name}의 하야 또는 조약 파기가 기록에 남았다.`,
    ({ name }) => `${subject(name)} 따르던 관계를 끝냈다.`,
  ],
};

export function reputationLine(kind: ReputationKind, value: PublicSubject, rng: Rng) {
  if (kind === 'conquest' && !value.city) throw Error('점령 문장에는 공개 도시가 필요합니다.');
  return rng.pick(REPUTATION_LINES[kind])(value);
}
export function reputationHeadline(year: number, month: number, entries: readonly { rank: number; name: string }[]) {
  return entries.length
    ? `${year}년 ${month}월 월단평 ${entries.map((entry) => `${entry.rank}위 ${entry.name}`).join(', ')}`
    : null;
}
