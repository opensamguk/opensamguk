// 출처: core2026 df6c926, packages/logic/src/tournament/battle.ts (MIT, resources/NOTICE.md).
import type { Rng } from '@opensamguk/shared';
import { MAX_PARTICIPANT_ID } from './bracket';

export const TOURNAMENT_EVENTS = ['total', 'leadership', 'strength', 'intel'] as const;
export type TournamentEvent = (typeof TOURNAMENT_EVENTS)[number];
export const TOURNAMENT_MAX_PHASES = 100;

export interface TournamentFighter {
  participantId: number;
  leadership: number;
  strength: number;
  intel: number;
}

export interface TournamentExchange {
  phase: number;
  homeEnergy: number;
  awayEnergy: number;
  homeDamage: number;
  awayDamage: number;
  homeFury: boolean;
  awayFury: boolean;
}

export interface TournamentMatchResult {
  winnerId: number;
  loserId: number;
  decidedBy: 'knockout' | 'double-knockout' | 'phase-limit';
  initialEnergy: { home: number; away: number };
  exchanges: readonly TournamentExchange[];
}

type MatchInput = { event: TournamentEvent; home: TournamentFighter; away: TournamentFighter };
const fighterKeys = ['participantId', 'leadership', 'strength', 'intel'] as const;
const statKeys = ['leadership', 'strength', 'intel'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function validateInput(input: MatchInput): void {
  if (!isRecord(input) || !TOURNAMENT_EVENTS.some((event) => event === input.event)) {
    throw new Error('경기 종목이 올바르지 않습니다.');
  }
  const fighters = [input.home, input.away];
  for (const fighter of fighters) {
    if (
      !isRecord(fighter) ||
      !Number.isSafeInteger(fighter.participantId) ||
      fighter.participantId < 1 ||
      fighter.participantId > MAX_PARTICIPANT_ID
    ) {
      throw new Error('경기 참가자 ID가 올바르지 않습니다.');
    }
  }
  if (input.home.participantId === input.away.participantId) {
    throw new Error('경기 참가자 ID가 중복됐습니다.');
  }
  for (const fighter of fighters) {
    for (const key of statKeys) {
      if (!Number.isSafeInteger(fighter[key]) || fighter[key] < 0 || fighter[key] > 100) {
        throw new Error('경기 능력치는 0 이상 100 이하 정수여야 합니다.');
      }
    }
  }
  if (
    !hasExactKeys(input, ['event', 'home', 'away']) ||
    fighters.some((fighter) => !hasExactKeys(fighter, fighterKeys))
  ) {
    throw new Error('경기 입력에 허용하지 않은 칸이 있습니다.');
  }
}

function statFor(event: TournamentEvent, fighter: TournamentFighter): number {
  return event === 'total' ? (fighter.leadership + fighter.strength + fighter.intel) * (7 / 15) : fighter[event];
}

export function resolveTournamentMatch(input: MatchInput, rng: Rng): TournamentMatchResult {
  validateInput(input);
  const homeStat = statFor(input.event, input.home);
  const awayStat = statFor(input.event, input.away);
  const initialEnergy = { home: Math.round(homeStat * 10), away: Math.round(awayStat * 10) };
  let homeEnergy = initialEnergy.home;
  let awayEnergy = initialEnergy.away;
  const exchanges: TournamentExchange[] = [];
  const result = (decidedBy: TournamentMatchResult['decidedBy']): TournamentMatchResult => {
    const homeWins = homeEnergy > awayEnergy;
    return {
      winnerId: homeWins ? input.home.participantId : input.away.participantId,
      loserId: homeWins ? input.away.participantId : input.home.participantId,
      decidedBy,
      initialEnergy,
      exchanges,
    };
  };

  for (let phase = 1; phase <= TOURNAMENT_MAX_PHASES; phase++) {
    let homeDamage = Math.round((awayStat * (rng.int(0, 21) + 90)) / 130);
    let awayDamage = Math.round((homeStat * (rng.int(0, 21) + 90)) / 130);
    if (homeStat >= rng.int(0, 100)) awayDamage += Math.round((homeStat * (rng.int(0, 41) + 10)) / 130);
    if (awayStat >= rng.int(0, 100)) homeDamage += Math.round((awayStat * (rng.int(0, 41) + 10)) / 130);

    let homeFury = false;
    let awayFury = false;
    let homeDamageFactor = 1;
    let awayDamageFactor = 1;
    if (initialEnergy.home / 5 > homeEnergy && homeDamage > awayDamage && homeStat >= rng.int(0, 300)) {
      awayDamageFactor = Math.round((rng.int(0, 301) + 200) / 100);
      homeFury = true;
    }
    if (initialEnergy.away / 5 > awayEnergy && awayDamage > homeDamage && awayStat >= rng.int(0, 300)) {
      homeDamageFactor = Math.round((rng.int(0, 301) + 200) / 100);
      awayFury = true;
    }
    homeDamage = Math.round(homeDamage * homeDamageFactor);
    awayDamage = Math.round(awayDamage * awayDamageFactor);

    if (phase === 1) {
      if (homeStat * 0.9 > awayStat && homeStat >= rng.int(0, 400)) {
        awayDamage += Math.round((homeStat * (rng.int(0, 31) + 70)) / 100);
      }
      if (awayStat * 0.9 > homeStat && awayStat >= rng.int(0, 400)) {
        homeDamage += Math.round((awayStat * (rng.int(0, 31) + 70)) / 100);
      }
    } else {
      if (!homeFury && homeStat >= rng.int(0, 1000)) {
        awayDamage += Math.round((homeStat * (rng.int(0, 31) + 20)) / 100);
      }
      if (!awayFury && awayStat >= rng.int(0, 1000)) {
        homeDamage += Math.round((awayStat * (rng.int(0, 31) + 20)) / 100);
      }
    }
    homeEnergy -= homeDamage;
    awayEnergy -= awayDamage;
    exchanges.push({ phase, homeEnergy, awayEnergy, homeDamage, awayDamage, homeFury, awayFury });
    if (homeEnergy <= 0 && awayEnergy <= 0) return result('double-knockout');
    if (homeEnergy <= 0 || awayEnergy <= 0) return result('knockout');
  }
  return result('phase-limit');
}
