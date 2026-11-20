// 작전 회의의 진로·수비 선택지 (D-099). 수치는 삼국지 7 공략 위키 실측을 출발점으로 둔 우리 기본값이다.
import type { BattleUnit, DefenseKey, RouteKey, Side } from './types';

export const ROUTES: ReadonlyArray<{ key: RouteKey; label: string; turnLimit: number; moraleSwing: number }> = [
  { key: 'front', label: '정면돌파', turnLimit: 15, moraleSwing: 40 },
  { key: 'left', label: '좌측 우회', turnLimit: 20, moraleSwing: 60 },
  { key: 'right', label: '우측 우회', turnLimit: 20, moraleSwing: 60 },
  { key: 'encircle', label: '포위', turnLimit: 25, moraleSwing: 80 },
];

export const DEFENSES: ReadonlyArray<{ key: DefenseKey; label: string; note: string }> = [
  { key: 'intercept', label: '요격', note: '야전에서 맞선다. 부대를 배치할 수 있다.' },
  { key: 'ambush', label: '기습', note: '야전에서 기습한다. 공격측의 진로 효과가 없어진다.' },
  { key: 'hold', label: '농성', note: '야전 없이 성에 들어가 공성전으로 바로 넘어간다.' },
];

export function routeNote(key: RouteKey): string {
  const route = ROUTES.find((entry) => entry.key === key)!;
  return `달성하면 사기 변동 ±${route.moraleSwing}. 유효 기간 ${route.turnLimit}턴.`;
}

/** 진로 화살표: 판 크기에 맞춘 경로 점(칸 좌표). 공격측은 판의 아래 모서리에서 출발해 위 모서리의 성으로 간다. */
export function routePaths(key: RouteKey, width: number, height: number): Array<Array<[number, number]>> {
  const start: [number, number] = [width - 1, height - 1];
  const goal: [number, number] = [0, 0];
  const mid = (fx: number, fy: number): [number, number] => [
    Math.round((width - 1) * fx),
    Math.round((height - 1) * fy),
  ];
  const left = [start, mid(0.85, 0.2), mid(0.35, 0.05), goal];
  const right = [start, mid(0.2, 0.85), mid(0.05, 0.35), goal];
  const front = [start, mid(0.5, 0.5), goal];
  if (key === 'front') return [front];
  if (key === 'left') return [left];
  if (key === 'right') return [right];
  return [left, front, right];
}

export function sideOfUnits(units: readonly BattleUnit[], side: Side) {
  return units.filter((unit) => unit.side === side && unit.status !== 'routed');
}
