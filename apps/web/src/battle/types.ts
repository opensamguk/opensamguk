// 전술 전투 화면이 읽는 형식 (D-099 "전술전투도 넣자", C안 섞기).
// 서버(Codex)의 전술 전투 계약은 이 형식에 맞춘다. 다시보기와 직접 지휘가 같은 판·부대 형식을 쓴다.

export type Side = 'attack' | 'defend';

/** 칸 지형. 우리 지도 타일(INT-27)에서 전장 칸을 뽑을 때 쓰는 값이다. */
export type Terrain =
  'plain' | 'grass' | 'sandbar' | 'forest' | 'mountain' | 'river' | 'ford' | 'bridge' | 'road' | 'marsh' | 'sea';

/** 칸 좌표 하나. 서버의 burningCells, visibleCells가 이 형식이다. */
export interface BattleCell {
  x: number;
  y: number;
}

/** 거점 지물 (D-105). 기본은 진영이다. */
export type BattleStructure = 'fort-small' | 'fort-medium' | 'fort-large' | 'gate' | 'camp' | 'village';

/** 판의 고정 지물 (D-105). 다리는 direction이 있고, 흙더미(earthwork)와 무너진 터(rubble)는 전투 효과가 있다. */
export type BattleObject =
  | (BattleCell & { kind: 'bridge'; direction: 'NE-SW' | 'NW-SE' })
  | (BattleCell & { kind: BattleStructure | 'earthwork' | 'rubble' });

/** 마름모 칸 판. terrain은 가로 줄 우선(y * width + x)이다. */
export interface BattleBoardData {
  width: number;
  height: number;
  terrain: Terrain[];
  /** 고정 지물. 공개 정보라 시야와 관계없이 온다. */
  objects?: BattleObject[];
}

export type Weather = 'clear' | 'rain' | 'downpour' | 'snow' | 'fog';
/** 북쪽은 y-1, 동쪽은 x+1이다. */
export type Wind = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export interface BattleEnvironment {
  weather: Weather;
  wind: Wind;
}

export type UnitStatus = 'normal' | 'confused' | 'stopped' | 'provoked' | 'ambush' | 'routed';

export interface BattleUnit {
  id: number;
  side: Side;
  generalName: string;
  portraitId?: number | null;
  crewTypeName: string;
  /** 병종 번호(확장 병종표). 있으면 병종 그림(battle/units/<id>)을 세운다. */
  crewTypeId?: number | null;
  troops: number;
  /** 전투 시작 병사. 막대 길이의 기준이다. */
  troopsMax: number;
  x: number;
  y: number;
  status: UnitStatus;
  role?: 'commander' | 'strategist' | null;
  /** 증원군·공동군. 없으면 정규군이다. */
  force?: 'main' | 'reinforce' | 'allied';
  /** 날씨와 지형을 반영한 시야 반경(1~4) */
  vision?: number;
  /** 이번 전투에서 새로 입은 화재 부상 누적 */
  injury?: number;
}

export interface BattleBase {
  id: number;
  x: number;
  y: number;
  /** contest: 다툼 거점, supply: 보급 거점 */
  kind: 'contest' | 'supply';
  /** 거점 지물 종류. 없으면 진영으로 그린다. */
  structure?: BattleStructure;
  owner: Side | null;
}

export type BattleEventKind =
  | 'move'
  | 'attack'
  | 'arrow'
  | 'charge'
  | 'duel'
  | 'scheme'
  | 'trap'
  | 'capture'
  | 'reinforce'
  | 'retreat'
  | 'siege'
  | 'morale'
  | 'end';

export interface BattleEvent {
  kind: BattleEventKind;
  text: string;
  actorId?: number | null;
  targetId?: number | null;
  /** 교전 결과 상자: 공·수 병사 변화 */
  exchange?: {
    attacker: string;
    attackerBefore: number;
    attackerAfter: number;
    defender: string;
    defenderBefore: number;
    defenderAfter: number;
  } | null;
}

export interface SideTotals {
  units: number;
  troops: number;
  rice: number;
  morale: number;
}

/** 한 턴이 끝난 뒤의 상태. frames[0]은 전투 시작 상태다. */
export interface BattleFrame {
  turn: number;
  /** 그 턴의 기상과 바람. 옛 프레임에는 없다. */
  environment?: BattleEnvironment;
  /** 내 편에서 보이는 타는 칸 */
  burningCells?: BattleCell[];
  /** 내 편에서 보이는 칸. 없으면(옛 프레임) 가리지 않고, 빈 배열이면 전부 가린다. */
  visibleCells?: BattleCell[];
  units: BattleUnit[];
  bases: BattleBase[];
  totals: Record<Side, SideTotals>;
  events: BattleEvent[];
  /** 공성전일 때만: 도시 방어도와 성문 */
  siege?: {
    defense: number;
    defenseMax: number;
    gate: number;
    gateMax: number;
    /** 장면과 성벽 재질. 서버가 거점으로 정해 보내고, 없으면 화면이 siegeScene 규칙으로 고른다. */
    layout?: 'corner' | 'bastion';
    material?: 'earth' | 'brick' | 'stone';
    weather?: 'clear' | 'cloud' | 'rain' | 'snow';
  } | null;
}

export type RouteKey = 'front' | 'left' | 'right' | 'encircle';
export type DefenseKey = 'intercept' | 'ambush' | 'hold';

export interface SideInfo {
  nationName: string;
  color: string;
  commander: string;
  strategist: string | null;
  schemePoints: number;
}

export interface TacticalBattle {
  id: string;
  year: number;
  month: number;
  place: string;
  phase: 'council' | 'field' | 'siege' | 'ended';
  turnLimit: number;
  route: RouteKey | null;
  defense: DefenseKey | null;
  board: BattleBoardData;
  sides: Record<Side, SideInfo>;
  frames: BattleFrame[];
  result: Side | 'draw' | null;
  /** 직접 지휘: 지금 전장 턴을 내가 지휘할 수 있으면 마감 시각(ISO), 아니면 null(예약 전투 다시보기) */
  liveUntil?: string | null;
}
