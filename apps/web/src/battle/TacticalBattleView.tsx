// 전술 전투 화면 (D-099, C안 섞기). 작전 회의 → 야전 → 공성전.
// 예약 전투는 frames를 턴마다 넘겨 보는 다시보기이고, liveUntil이 있으면 내 부대에 이동을 지시한다.
// 야전과 공성은 화면을 가득 채우는 무대 위에 전황, 비교, 고른 부대, 턴 넘기기 판을 얹는다(사용자 2026-11-15 "좋아 이대로").
import { type CSSProperties, useMemo, useState } from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { BattleBoard, moveReach } from './BattleBoard';
import { DEFENSES, ROUTES, routeNote, routePaths } from './council';
import { WEATHER_LABEL, WIND_LABEL, attackCells, weatherOverlay, windScreen } from './fieldRules';
import type {
  BattleEvent,
  BattleFrame,
  BattleUnit,
  DefenseKey,
  RouteKey,
  Side,
  SideTotals,
  TacticalBattle,
} from './types';
import { SiegeScene, siegeSceneReady } from './SiegeScene';
import styles from './TacticalBattleView.module.css';

const SIDE_LABEL: Record<Side, string> = { attack: '공', defend: '수' };

export function BattleHud({ battle, frame }: { battle: TacticalBattle; frame: BattleFrame }) {
  const left = Math.max(0, battle.turnLimit - frame.turn);
  const route = battle.route ? ROUTES.find((entry) => entry.key === battle.route) : null;
  return (
    <dl className={styles.hud} aria-label="전황">
      <div>
        <dt className={styles.srOnly}>연월</dt>
        <dd>
          {battle.year}년 {battle.month}월
        </dd>
      </div>
      <div>
        <dt className={styles.srOnly}>장소</dt>
        <dd>{battle.place} 전투</dd>
      </div>
      <div>
        <dt>남은 턴</dt>
        <dd>{left}</dd>
      </div>
      {frame.environment ? (
        <>
          <div>
            <dt>날씨</dt>
            <dd>{WEATHER_LABEL[frame.environment.weather]}</dd>
          </div>
          <div>
            <dt>바람</dt>
            <dd>
              <span
                className={styles.windArrow}
                style={{ transform: `rotate(${windScreen(frame.environment.wind).angle}deg)` }}
                aria-hidden="true"
              >
                →
              </span>
              {WIND_LABEL[frame.environment.wind]}쪽으로
            </dd>
          </div>
        </>
      ) : null}
      {frame.siege ? (
        <div>
          <dt>방어</dt>
          <dd>{frame.siege.defense}</dd>
        </div>
      ) : route ? (
        <div>
          <dt>작전</dt>
          <dd>{Math.max(0, route.turnLimit - frame.turn)}턴</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Pie({ value, color }: { value: number; color: string }) {
  const ratio = Math.max(0, Math.min(100, value)) / 100;
  return (
    <span
      className={styles.pie}
      style={{ background: `conic-gradient(${color} ${ratio * 360}deg, #2a221b 0)` }}
      aria-hidden="true"
    />
  );
}

export function SideCompare({ battle, totals }: { battle: TacticalBattle; totals: Record<Side, SideTotals> }) {
  const rows: Array<[string, keyof SideTotals]> = [
    ['부대', 'units'],
    ['병사', 'troops'],
    ['군량', 'rice'],
    ['사기', 'morale'],
  ];
  return (
    <section className={styles.compare} aria-label="공격과 수비 비교">
      <Pie value={totals.attack.morale} color={battle.sides.attack.color} />
      <table>
        <thead>
          <tr>
            <th scope="col">{SIDE_LABEL.attack}</th>
            <th scope="col" />
            <th scope="col">{SIDE_LABEL.defend}</th>
          </tr>
          <tr>
            <td>{battle.sides.attack.nationName}</td>
            <td />
            <td>{battle.sides.defend.nationName}</td>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, key]) => (
            <tr key={key}>
              <td className="num">{totals.attack[key].toLocaleString()}</td>
              <th scope="row">{label}</th>
              <td className="num">{totals.defend[key].toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pie value={totals.defend.morale} color={battle.sides.defend.color} />
    </section>
  );
}

export function EventBox({ events }: { events: readonly BattleEvent[] }) {
  const event = [...events].reverse().find((entry) => entry.exchange) ?? events.at(-1);
  if (!event) return null;
  return (
    <div className={styles.eventBox} role="status" aria-label="전투 소식">
      {event.exchange ? (
        <table>
          <tbody>
            <tr>
              <th scope="row">공격</th>
              <td>{event.exchange.attacker}</td>
              <td className="num">
                {event.exchange.attackerBefore.toLocaleString()} → {event.exchange.attackerAfter.toLocaleString()}
              </td>
            </tr>
            <tr>
              <th scope="row">방어</th>
              <td>{event.exchange.defender}</td>
              <td className="num">
                {event.exchange.defenderBefore.toLocaleString()} → {event.exchange.defenderAfter.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p>{event.text}</p>
      )}
    </div>
  );
}

function UnitCard({ unit, battle }: { unit: BattleUnit | null; battle: TacticalBattle }) {
  if (!unit) return <p className={styles.muted}>부대를 고르면 장수 정보가 나옵니다.</p>;
  const side = battle.sides[unit.side];
  const role = unit.role === 'commander' ? '총대장' : unit.role === 'strategist' ? '참모' : '부대장';
  return (
    <div className={styles.unitCard}>
      <p className={styles.unitName} style={{ borderColor: side.color }}>
        {unit.generalName}
        <small>
          {side.nationName}군 · {role}
        </small>
      </p>
      <dl>
        <div>
          <dt>병과</dt>
          <dd>{unit.crewTypeName}</dd>
        </div>
        <div>
          <dt>병사</dt>
          <dd className="num">
            {unit.troops.toLocaleString()} / {unit.troopsMax.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{STATUS_LABEL[unit.status]}</dd>
        </div>
        {unit.vision != null ? (
          <div>
            <dt>시야</dt>
            <dd className="num">{unit.vision}칸</dd>
          </div>
        ) : null}
        {unit.injury ? (
          <div>
            <dt>화상 부상</dt>
            <dd className="num">{unit.injury}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

const STATUS_LABEL: Record<BattleUnit['status'], string> = {
  normal: '정상',
  confused: '혼란',
  stopped: '저지',
  provoked: '도발',
  ambush: '복병',
  routed: '궤멸',
};

export function CouncilScreen({
  battle,
  mySide,
  onRoute,
  onDefense,
}: {
  battle: TacticalBattle;
  mySide: Side | null;
  onRoute?: ((route: RouteKey) => void) | undefined;
  onDefense?: ((defense: DefenseKey) => void) | undefined;
}) {
  const frame = battle.frames[0]!;
  const [route, setRoute] = useState<RouteKey>(battle.route ?? 'front');
  const [defense, setDefense] = useState<DefenseKey>(battle.defense ?? 'intercept');
  const [selected, setSelected] = useState<number | null>(
    frame.units.find((unit) => unit.side === mySide && unit.role === 'commander')?.id ?? null,
  );
  const unit = frame.units.find((entry) => entry.id === selected) ?? null;
  const colors = { attack: battle.sides.attack.color, defend: battle.sides.defend.color };
  const attack = battle.sides.attack;
  const force = (kind: BattleUnit['force']) =>
    frame.units.filter((entry) => entry.side === 'attack' && (entry.force ?? 'main') === kind);
  return (
    <div className={styles.council}>
      <aside className={styles.leftPanel} aria-label="부대 정보">
        <UnitCard unit={unit} battle={battle} />
      </aside>
      <div className={styles.table}>
        <span className={styles.compass} data-dir="n">
          북
        </span>
        <span className={styles.compass} data-dir="e">
          동
        </span>
        <span className={styles.compass} data-dir="s">
          남
        </span>
        <span className={styles.compass} data-dir="w">
          서
        </span>
        <BattleBoard
          board={battle.board}
          units={frame.units}
          bases={frame.bases}
          sideColor={colors}
          paths={mySide !== 'defend' ? routePaths(route, battle.board.width, battle.board.height) : []}
          selectedId={selected}
          burning={frame.burningCells}
          visible={frame.visibleCells}
          compact
          fit
          label={`${battle.place} 작전 지도`}
          onTile={(x, y) => setSelected(frame.units.find((entry) => entry.x === x && entry.y === y)?.id ?? null)}
        />
        <p className={styles.legend}>
          <span className={styles.legendContest} /> 다툼 거점 <span className={styles.legendSupply} /> 보급 거점
        </p>
        {mySide === 'defend' ? (
          <div className={styles.choices} role="group" aria-label="수비 방법">
            {DEFENSES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={defense === entry.key}
                onClick={() => {
                  setDefense(entry.key);
                  onDefense?.(entry.key);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.choices} role="group" aria-label="진로">
            {ROUTES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={route === entry.key}
                disabled={mySide === null}
                onClick={() => {
                  setRoute(entry.key);
                  onRoute?.(entry.key);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className={styles.rightPanel} aria-label="편성">
        <dl>
          <div>
            <dt>작전</dt>
            <dd>
              {mySide === 'defend'
                ? DEFENSES.find((entry) => entry.key === defense)!.label
                : ROUTES.find((entry) => entry.key === route)!.label}
            </dd>
          </div>
          <div className={styles.head}>
            <dt>공격측</dt>
            <dd />
          </div>
          <div>
            <dt>정규군</dt>
            <dd>{attack.nationName}군</dd>
          </div>
          <div>
            <dt>총대장</dt>
            <dd>{attack.commander}</dd>
          </div>
          <div>
            <dt>참군</dt>
            <dd>{attack.strategist ?? '－'}</dd>
          </div>
          {(['main', 'reinforce', 'allied'] as const).map((kind) => (
            <div key={kind}>
              <dt>{kind === 'main' ? '부대' : kind === 'reinforce' ? '증원군' : '공동군'}</dt>
              <dd className="num">
                {force(kind).length} ·{' '}
                {force(kind)
                  .reduce((sum, entry) => sum + entry.troops, 0)
                  .toLocaleString()}
              </dd>
            </div>
          ))}
          <div>
            <dt>책략 점수</dt>
            <dd className="num">{battle.sides[mySide ?? 'attack'].schemePoints}</dd>
          </div>
        </dl>
      </aside>
      <SideCompare battle={battle} totals={frame.totals} />
      <p className={styles.note}>
        {mySide === 'defend' ? DEFENSES.find((entry) => entry.key === defense)!.note : routeNote(route)}
      </p>
    </div>
  );
}

export function SiegeWall({ frame }: { frame: BattleFrame }) {
  const siege = frame.siege!;
  const damage = 1 - siege.defense / Math.max(1, siege.defenseMax);
  const gate = 1 - siege.gate / Math.max(1, siege.gateMax);
  const stage = Math.min(4, Math.floor(damage * 5));
  const defenders = frame.units.filter((unit) => unit.side === 'defend' && unit.status !== 'routed');
  const attackers = frame.units.filter((unit) => unit.side === 'attack' && unit.status !== 'routed');
  return (
    <svg
      className={styles.siege}
      viewBox="0 0 960 520"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`성벽 손상 ${stage}단계, 성문 손상 ${Math.round(gate * 100)}%`}
    >
      <rect width="960" height="520" fill="#c9b98f" />
      <polygon points="0,90 960,90 960,0 0,0" fill="#9fb2bf" />
      <polygon points="40,120 520,60 520,330 40,420" fill="#8d8a84" />
      <polygon points="520,60 930,120 930,380 520,330" fill="#a5a19a" />
      <polygon points="40,120 520,60 930,120 520,170" fill="#b8b2a6" />
      <rect x="330" y="20" width="200" height="70" fill="#7a2f22" />
      <polygon points="320,25 540,25 520,5 340,5" fill="#3b3a38" />
      {Array.from({ length: stage }, (_, i) => (
        <path key={i} d={`M${150 + i * 90},${200 + (i % 2) * 40} l18,30 l-12,26 l20,34`} className={styles.crack} />
      ))}
      <rect x="700" y="250" width="56" height="80" fill={gate > 0.66 ? '#2a1d14' : '#5a3a20'} />
      {gate > 0.33 ? <path d="M700,250 l56,80 M756,250 l-56,80" className={styles.crack} /> : null}
      {defenders.slice(0, 12).map((unit, i) => (
        <g key={unit.id}>
          <rect x={90 + i * 66} y={i < 7 ? 110 - i * 8 : 60 + (i - 7) * 10} width="12" height="18" fill="#c8a24a" />
          <title>{`${unit.generalName} ${unit.troops.toLocaleString()}`}</title>
        </g>
      ))}
      {attackers.slice(0, 12).map((unit, i) => (
        <g key={unit.id}>
          <rect x={560 + (i % 4) * 90} y={400 + Math.floor(i / 4) * 36} width="40" height="22" fill="#3c5fa8" />
          <text x={580 + (i % 4) * 90} y={415 + Math.floor(i / 4) * 36} className={styles.siegeTroops}>
            {Math.round(unit.troops / 100) / 10}천
          </text>
          <title>{`${unit.generalName} ${unit.troops.toLocaleString()}`}</title>
        </g>
      ))}
    </svg>
  );
}

/** 날씨 덮개: 비, 눈, 안개 무늬를 바람 쪽으로 흘린다. 누름은 아래 판으로 지나간다. */
export function WeatherLayer({ frame }: { frame: BattleFrame }) {
  const overlay = weatherOverlay(frame.environment?.weather, frame.environment?.wind);
  if (!overlay) return null;
  const style = {
    backgroundImage: overlay.url ? `url("${overlay.url}")` : undefined,
    animationDuration: `${overlay.seconds}s`,
    '--drift-x': overlay.dx,
    '--drift-y': overlay.dy,
  } as CSSProperties;
  return <div className={styles.weather} data-weather={overlay.weather} style={style} aria-hidden="true" />;
}

const GROUND = 'apps/web/src/art/city/scene/ground/camp-plain.webp';
// 야전 바닥: 진영 들판 그림을 어둡게 깔아 판이 떠 보이게 한다. 그림이 없으면 CSS 바탕색만 쓴다.
const FIELD_BACKDROP: CSSProperties | undefined = hasPublicImage(GROUND)
  ? {
      backgroundImage: `linear-gradient(rgb(20 14 8 / 0.55), rgb(20 14 8 / 0.55)), url("${publicImageUrl(GROUND)}")`,
    }
  : undefined;

export function TacticalBattleView({
  battle,
  mySide = null,
  myGeneralIds = [],
  onMove,
  onRoute,
  onDefense,
}: {
  battle: TacticalBattle;
  mySide?: Side | null;
  myGeneralIds?: readonly number[];
  onMove?: ((unitId: number, x: number, y: number) => void) | undefined;
  onRoute?: ((route: RouteKey) => void) | undefined;
  onDefense?: ((defense: DefenseKey) => void) | undefined;
}) {
  const [turn, setTurn] = useState(battle.frames.length - 1);
  const [selected, setSelected] = useState<number | null>(null);
  const frame = battle.frames[Math.min(turn, battle.frames.length - 1)]!;
  const live = Boolean(battle.liveUntil) && turn === battle.frames.length - 1;
  const unit = frame.units.find((entry) => entry.id === selected) ?? null;
  const mine = live && unit !== null && myGeneralIds.includes(unit.id);
  const reach = useMemo(
    () => (mine && unit ? moveReach(battle.board, frame.units, unit, 4) : undefined),
    [mine, unit, battle.board, frame.units],
  );
  const attack = useMemo(() => (mine ? attackCells(frame.units, unit) : undefined), [mine, unit, frame.units]);
  if (battle.phase === 'council')
    return <CouncilScreen battle={battle} mySide={mySide} onRoute={onRoute} onDefense={onDefense} />;
  const colors = { attack: battle.sides.attack.color, defend: battle.sides.defend.color };
  const onTile = (x: number, y: number) => {
    if (reach?.has(`${x},${y}`) && unit) {
      onMove?.(unit.id, x, y);
      setSelected(null);
      return;
    }
    setSelected(frame.units.find((entry) => entry.x === x && entry.y === y && entry.status !== 'routed')?.id ?? null);
  };
  return (
    <div
      className={styles.field}
      data-phase={frame.siege ? 'siege' : 'field'}
      style={frame.siege ? undefined : FIELD_BACKDROP}
    >
      <BattleHud battle={battle} frame={frame} />
      <div className={styles.stage}>
        {frame.siege ? (
          siegeSceneReady(frame.siege.layout, frame.siege.material) ? (
            <SiegeScene frame={frame} />
          ) : (
            <SiegeWall frame={frame} />
          )
        ) : (
          <BattleBoard
            board={battle.board}
            units={frame.units}
            bases={frame.bases}
            sideColor={colors}
            reach={reach}
            attack={attack}
            selectedId={selected}
            burning={frame.burningCells}
            visible={frame.visibleCells}
            onTile={onTile}
            fit
            label={`${battle.place} 야전 ${frame.turn}턴`}
          />
        )}
        <WeatherLayer frame={frame} />
        <EventBox events={frame.events} />
      </div>
      <SideCompare battle={battle} totals={frame.totals} />
      {unit || live ? (
        <aside className={styles.side} aria-label="고른 부대">
          {unit ? <UnitCard unit={unit} battle={battle} /> : null}
          {live ? (
            <p className={styles.live}>직접 지휘 중입니다. 내 부대를 고르고 노란 칸을 누르면 이동을 지시합니다.</p>
          ) : null}
        </aside>
      ) : null}
      <div className={styles.playback} role="group" aria-label="턴 넘기기">
        <button type="button" onClick={() => setTurn(0)} disabled={turn === 0}>
          처음
        </button>
        <button type="button" onClick={() => setTurn((value) => Math.max(0, value - 1))} disabled={turn === 0}>
          이전 턴
        </button>
        <label>
          <span className={styles.srOnly}>턴</span>
          <input
            type="range"
            min={0}
            max={battle.frames.length - 1}
            value={turn}
            onChange={(event) => setTurn(Number(event.target.value))}
          />
        </label>
        <output>
          {frame.turn} / {battle.turnLimit}턴
        </output>
        <button
          type="button"
          onClick={() => setTurn((value) => Math.min(battle.frames.length - 1, value + 1))}
          disabled={turn === battle.frames.length - 1}
        >
          다음 턴
        </button>
      </div>
      {battle.result ? (
        <p className={styles.result} data-result={battle.result}>
          {battle.result === 'draw' ? '무승부' : `${battle.sides[battle.result].nationName}군 승리`}
        </p>
      ) : null}
    </div>
  );
}
