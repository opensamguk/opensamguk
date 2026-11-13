import { displayName } from '../game/names';
import { isDetailedGeneral, type NationView } from '../game/types';
import type { PersonnelBoard, PersonnelMember } from './contract';

// 인사부 임명 후보 카드에 붙이는 장수 정보 (INT-25 단계 3). personnel.officers에는 능력치가 없어
// 같은 국가의 nation.get 장수를 generalId로 잇는다. 공개 범위 밖이면 서버가 빼므로 없는 장수는 비워 둔다.
export interface MemberDetail {
  portraitId: number | null;
  leadership: number;
  strength: number;
  intel: number;
  politics?: number | undefined;
  charm?: number | undefined;
  personality: string | null;
  special: string | null;
  // 부곡 월드는 지휘하는 부곡 병력, 아니면 장수 병력이다.
  troops: number;
  injury: number;
}

export type StatKey = 'leadership' | 'strength' | 'intel' | 'politics' | 'charm';
export const STAT_LABELS: ReadonlyArray<readonly [StatKey, string]> = [
  ['leadership', '통솔'],
  ['strength', '무력'],
  ['intel', '지력'],
  ['politics', '정치'],
  ['charm', '매력'],
];

export function memberDetails(generals: NationView['generals']): Map<number, MemberDetail> {
  const details = new Map<number, MemberDetail>();
  for (const general of generals) {
    if (!isDetailedGeneral(general)) continue;
    const army = 'commandedArmy' in general ? (general.commandedArmy as { troops: number } | undefined) : undefined;
    details.set(general.id, {
      portraitId: general.portraitId ?? null,
      leadership: general.leadership,
      strength: general.strength,
      intel: general.intel,
      politics: general.politics,
      charm: general.charm,
      personality: general.personality ?? null,
      special: general.special ?? null,
      troops: army?.troops ?? general.crew,
      injury: general.injury,
    });
  }
  return details;
}

// 보이는 능력치. 5능력치 월드가 아니면 통솔·무력·지력 셋이다.
export function statEntries(detail: MemberDetail): Array<{ key: StatKey; label: string; value: number }> {
  return STAT_LABELS.flatMap(([key, label]) => {
    const value = detail[key];
    return value === undefined ? [] : [{ key, label, value }];
  });
}

export const statTotal = (detail: MemberDetail | undefined) =>
  detail === undefined ? null : statEntries(detail).reduce((sum, stat) => sum + stat.value, 0);

// 성격·특기 이름 딱지. 효과 설명은 규칙에 효과가 생긴 뒤에 붙인다.
export function traitTags(detail: MemberDetail | undefined): string[] {
  if (!detail) return [];
  return [detail.personality, detail.special].filter((tag): tag is string => tag !== null && tag.trim() !== '');
}

// 이름은 괄호를 빼고 보인다. 같은 화면에서 겹치면 괄호를 그대로 둔다 (D-085).
export function nameLabels(members: readonly PersonnelMember[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const member of members) {
    const shown = displayName(member.name);
    counts.set(shown, (counts.get(shown) ?? 0) + 1);
  }
  return new Map(
    members.map((member) => {
      const shown = displayName(member.name);
      return [member.generalId, (counts.get(shown) ?? 0) > 1 ? member.name : shown];
    }),
  );
}

// 임명 가능: 직책이 없는 장수. 다른 관직: 다른 수뇌 자리에 앉아 있어 옮기면 그 자리가 빈다.
export type CandidateState = { kind: 'free' } | { kind: 'office'; title: string };

export interface Candidate {
  member: PersonnelMember;
  label: string;
  detail: MemberDetail | undefined;
  state: CandidateState;
  total: number | null;
}

// 군주는 후보가 아니다. 다른 수뇌 자리의 장수도 옮길 수 있으므로 상태 딱지를 달아 함께 둔다. 최종 판단은 서버가 한다.
// 직책 없는 장수를 먼저, 그 안에서 능력치 합이 큰 순으로 둔다.
export function appointCandidates(
  board: PersonnelBoard,
  details: ReadonlyMap<number, MemberDetail> | undefined,
  labels: ReadonlyMap<number, string> = nameLabels(board.members),
): Candidate[] {
  const holders = new Set(board.levels.map((level) => level.holderId).filter((id) => id !== null));
  return board.members
    .filter((member) => holders.has(member.generalId) || member.officerLevel <= 1)
    .map((member): Candidate => {
      const detail = details?.get(member.generalId);
      return {
        member,
        label: labels.get(member.generalId) ?? member.name,
        detail,
        state: holders.has(member.generalId) ? { kind: 'office', title: member.title } : { kind: 'free' },
        total: statTotal(detail),
      };
    })
    .sort(
      (a, b) =>
        (a.state.kind === 'free' ? 0 : 1) - (b.state.kind === 'free' ? 0 : 1) ||
        (b.total ?? -1) - (a.total ?? -1) ||
        a.member.generalId - b.member.generalId,
    );
}

// 이름(괄호 포함)·도시·직책·성격·특기로 거른다. 빈 칸이면 모두 보인다.
export function matchesCandidate(candidate: Candidate, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  if (needle === '') return true;
  return [
    candidate.label,
    candidate.member.name,
    candidate.member.city.name,
    candidate.member.title,
    ...traitTags(candidate.detail),
  ].some((text) => text.toLocaleLowerCase('ko-KR').includes(needle));
}
