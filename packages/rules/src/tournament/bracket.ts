import type { Rng } from '@opensamguk/shared';

export const MIN_BRACKET_PARTICIPANTS = 2;
export const MAX_BRACKET_PARTICIPANTS = 1024;
export const MAX_PARTICIPANT_ID = 2_147_483_647;

export type BracketSlot =
  { kind: 'participant'; participantId: number } | { kind: 'winnerOf'; round: number; index: number } | { kind: 'bye' };

export interface BracketMatch {
  round: number;
  index: number;
  home: BracketSlot;
  away: BracketSlot;
}

export interface Bracket {
  size: number;
  byes: readonly number[];
  rounds: readonly (readonly BracketMatch[])[];
}

export function createBracket(participants: readonly number[], rng: Rng): Bracket {
  if (
    !Array.isArray(participants) ||
    participants.length < MIN_BRACKET_PARTICIPANTS ||
    participants.length > MAX_BRACKET_PARTICIPANTS
  ) {
    throw new Error('대진 참가자는 2명 이상 1024명 이하여야 합니다.');
  }
  const seen = new Set<number>();
  for (let i = 0; i < participants.length; i++) {
    const id = participants[i];
    if (
      !Object.hasOwn(participants, i) ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      id > MAX_PARTICIPANT_ID
    ) {
      throw new Error('대진 참가자 ID가 올바르지 않습니다.');
    }
    if (seen.has(id)) throw new Error('대진 참가자 ID가 중복됐습니다.');
    seen.add(id);
  }

  const draw = [...participants].sort((a, b) => a - b);
  for (let i = draw.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [draw[i], draw[j]] = [draw[j]!, draw[i]!];
  }

  let size = 2;
  while (size < draw.length) size *= 2;
  const byes = draw.slice(0, size - draw.length);
  const firstRound: BracketMatch[] = [];
  for (let index = 0; index < size / 2; index++) {
    const hasBye = index < byes.length;
    const position = hasBye ? index : byes.length + 2 * (index - byes.length);
    firstRound.push({
      round: 1,
      index,
      home: { kind: 'participant', participantId: draw[position]! },
      away: hasBye ? { kind: 'bye' } : { kind: 'participant', participantId: draw[position + 1]! },
    });
  }

  const rounds: BracketMatch[][] = [firstRound];
  for (let count = firstRound.length / 2; count >= 1; count /= 2) {
    const round = rounds.length + 1;
    const matches: BracketMatch[] = [];
    for (let index = 0; index < count; index++) {
      matches.push({
        round,
        index,
        home: { kind: 'winnerOf', round: round - 1, index: 2 * index },
        away: { kind: 'winnerOf', round: round - 1, index: 2 * index + 1 },
      });
    }
    rounds.push(matches);
  }
  return { size, byes, rounds };
}
