import type { TagTone } from '../ui/Tag';
import type { LobbyWorld } from './contract';

// 로비 카드에 쓰는 글자와 버튼 고르기. 기준은 docs/plans/T2-04.md 화면 절.

export const STATUS_LABEL: Record<LobbyWorld['status'], { text: string; tone: TagTone }> = {
  RUNNING: { text: '진행 중', tone: 'accent' },
  PREOPEN: { text: '가오픈', tone: 'info' },
  PAUSED: { text: '멈춤', tone: 'warning' },
  ENDED: { text: '끝남', tone: 'muted' },
};

// 월/일은 보는 사람의 시간대로 쓴다.
export function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function startedText(startedAt: string | null): string {
  return startedAt === null ? '시작 전' : `시작 ${shortDate(startedAt)}`;
}

// 정원 키가 없으면(D-025 승인 전) 인원만, 있으면 인원/정원, 정원이 null이면 —.
export function generalsText(world: Pick<LobbyWorld, 'humanGenerals' | 'maxHumanGenerals'>): string {
  if (world.maxHumanGenerals === undefined) return `장수 ${world.humanGenerals}`;
  return `장수 ${world.humanGenerals}/${world.maxHumanGenerals ?? '—'}`;
}

export function metaText(world: LobbyWorld): string[] {
  return [
    `${world.scenarioTitle}(${world.startYear})`,
    `${world.gameDate.year}년 ${world.gameDate.month}월`,
    `턴 ${world.turnTermMinutes}분`,
    generalsText(world),
    startedText(world.startedAt),
  ];
}

export function myGeneralText(general: LobbyWorld['myGeneral']): string {
  if (!general) return '내 장수 없음';
  return `내 장수: ${general.name} (${general.nationName ?? '재야'})`;
}

export type LobbyAction =
  { kind: 'enter' } | { kind: 'create'; blocked: string | null } | { kind: 'login'; blocked: string | null };

// 버튼은 auth.me와 myGeneral, createBlockedReason만 보고 고른다. 월드 상태로 추측하지 않는다.
export function lobbyAction(
  loggedIn: boolean,
  world: Pick<LobbyWorld, 'myGeneral' | 'createBlockedReason'>,
): LobbyAction {
  if (!loggedIn) return { kind: 'login', blocked: world.createBlockedReason };
  if (world.myGeneral) return { kind: 'enter' };
  return { kind: 'create', blocked: world.createBlockedReason };
}
