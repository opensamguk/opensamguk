// 성 안 창(D-106). 사용자 2026-11-15: "성 안 자리는 성을 클릭하면 뭐를 설치할 수 있는지 보이게 만들면 되겠지."
// 왼쪽은 성 안 자리, 오른쪽은 성 안에 지을 수 있는 건물(INT-28 성 안 목록)이다. 조건이 안 맞는 건물은 흐리게 하고 이유를 단다.
// 아군 성이면 서버 land의 성 안 자리, 비용, 기간, 자리별 막힌 이유를 쓰고 고른 건설을 예턴에 넣는다(D-107).
// land가 없으면(재야, 적 성) 아래 고정 목록을 보기만 한다.
import { useState, type KeyboardEvent } from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { CITY_LAND, buildingName, facilityIcon, type CityGrade, type CityLand, type LandSlot } from './CityScene';
import { LotPicker, type Reserve } from './LotWindow';
import { UpgradePanel, type ScaleReserve } from './UpgradePanel';
import styles from './CastleWindow.module.css';

/** 성 안에 짓는 건물(INT-28 "성 안과 성 밖", 사용자 확정). 아이콘 이름, 이름, 맞추는 수치, 조건. */
export const INSIDE_BUILDINGS: ReadonlyArray<{
  icon: string;
  name: string;
  effect: string;
  limit?:
    | { kind: 'onePerCity' }
    | { kind: 'grade'; grades: readonly CityGrade[]; label: string }
    | { kind: 'city'; city: string };
}> = [
  {
    icon: 'office',
    name: '관청',
    effect: '명령 비용 감소(군사, 인재, 외교, 계략 가운데 하나)',
    limit: { kind: 'onePerCity' },
  },
  { icon: 'tally', name: '부절대', effect: '장수 행동 관련', limit: { kind: 'onePerCity' } },
  { icon: 'market', name: '시장', effect: '상업' },
  {
    icon: 'grand',
    name: '대시장',
    effect: '상업(시장의 3배)',
    limit: { kind: 'grade', grades: ['경', '특', '대'], label: '대 이상' },
  },
  { icon: 'mint', name: '조폐', effect: '이웃 시장 1.5배' },
  { icon: 'black', name: '암시장', effect: '상업(시장의 0.8배), 매년 1월 철거' },
  { icon: 'house', name: '민가', effect: '인구 상한' },
  { icon: 'patrol', name: '순찰소', effect: '치안' },
  { icon: 'shrine', name: '사당', effect: '민심' },
  { icon: 'academy', name: '학사', effect: '나라 기술' },
  { icon: 'clinic', name: '의원', effect: '장수 부상 회복' },
  { icon: 'tavern', name: '주점', effect: '인재 탐색' },
  { icon: 'forge', name: '대장간', effect: '보병, 궁병 장비' },
  { icon: 'workshop', name: '공방', effect: '병기(충차, 투석)' },
  { icon: 'arsenal', name: '무고', effect: '수비' },
  { icon: 'sparrow', name: '동작대', effect: '명성 등 특수', limit: { kind: 'city', city: '업' } },
];

/** 이 성에서 지을 수 없는 이유. 지을 수 있으면 null. */
export function insideBlock(
  building: (typeof INSIDE_BUILDINGS)[number],
  grade: CityGrade,
  cityName: string,
): string | null {
  const limit = building.limit;
  if (!limit) return null;
  if (limit.kind === 'grade') return limit.grades.includes(grade) ? null : limit.label;
  if (limit.kind === 'city') return cityName === limit.city ? null : `${limit.city} 한정`;
  return null;
}

const icon = (name: string) => {
  const path = `apps/web/src/art/city/facilities/icons/${name}.webp`;
  return hasPublicImage(path) ? publicImageUrl(path) : null;
};

export function CastleWindow({
  cityName,
  grade,
  land,
  onReserve,
  onScaleReserve,
  nationTurnsHref,
  onClose,
}: {
  cityName: string;
  grade: CityGrade;
  /** 서버 건설 정보(아군 성). null이면(재야, 적 성) 건물 목록만 보인다. */
  land?: CityLand | null | undefined;
  onReserve?: Reserve | undefined;
  /** 증축, 감축을 국가 예턴에 넣는다(INT-30). */
  onScaleReserve?: ScaleReserve | undefined;
  nationTurnsHref?: string | undefined;
  onClose: () => void;
}) {
  const core = CITY_LAND[grade].core;
  const w = Math.min(46, 120 / core);
  const h = w / 2;
  const half = (core - 1) / 2;
  const slots: ReadonlyArray<{ id: string; i: number; j: number; building: LandSlot['building'] }> = land
    ? land.slots.filter((slot) => slot.zone === 'inside')
    : Array.from({ length: core }, (_, i) =>
        Array.from({ length: core }, (_, j) => ({
          id: `${i - half},${j - half}`,
          i: i - half,
          j: j - half,
          building: null,
        })),
      ).flat();
  const firstEmpty = slots.find((slot) => !slot.building) ?? slots[0];
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = slots.find((slot) => slot.id === picked) ?? firstEmpty;
  const empty = slots.filter((slot) => !slot.building).length;
  const lines = land ? slots.length : core * core;
  const size = Math.max(...slots.map((slot) => Math.abs(slot.i) + Math.abs(slot.j)), 0) + 1;
  const press = (id: string) => (event: KeyboardEvent<SVGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setPicked(id);
    }
  };
  return (
    <section className={`kit-window ${styles.window}`} aria-labelledby="castle-title" data-testid="castle-window">
      <header className={styles.head}>
        <h2 id="castle-title" className={`kit-title ${styles.title}`}>
          {cityName}성 안 ({grade})
        </h2>
        <button type="button" className="kit-button" data-kind="secondary" onClick={onClose}>
          닫기
        </button>
      </header>
      {land ? <UpgradePanel land={land} onReserve={onScaleReserve} nationTurnsHref={nationTurnsHref} /> : null}
      <div className={styles.body}>
        <div className={styles.slots}>
          <svg
            width="250"
            height={size * 2 * h + 12}
            viewBox={`${-size * w - 4} ${-size * h - 4} ${2 * size * w + 8} ${size * 2 * h + 12}`}
            role={land ? 'group' : 'img'}
            aria-label={
              empty === lines ? `성 안 자리 ${lines}칸, 모두 빈 터` : `성 안 자리 ${lines}칸, 빈 터 ${empty}칸`
            }
          >
            {slots.map((slot) => {
              const x = (slot.i - slot.j) * w;
              const y = (slot.i + slot.j) * h;
              const row = slot.building;
              const url = row ? facilityIcon(row.building) : null;
              const active = land && chosen?.id === slot.id;
              const name = row && land ? buildingName(land, row.building) : '빈 터';
              return (
                <g
                  key={slot.id}
                  data-slot={slot.id}
                  data-building={row?.building}
                  {...(land
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': `성 안 ${slot.id} ${name}`,
                        'aria-pressed': Boolean(active),
                        style: { cursor: 'pointer' },
                        onClick: () => setPicked(slot.id),
                        onKeyDown: press(slot.id),
                      }
                    : {})}
                >
                  <polygon
                    points={`${x},${y - h} ${x + w},${y} ${x},${y + h} ${x - w},${y}`}
                    fill={active ? '#7a5c38' : '#5a4630'}
                    stroke={active ? '#ffe08a' : '#c9a25a'}
                    strokeWidth={active ? 2.5 : 1}
                  />
                  {row ? (
                    <g opacity={row.remainingTurns > 0 ? 0.55 : 1} pointerEvents="none">
                      {url ? (
                        <image href={url} x={x - w * 0.6} y={y - w * 0.85} width={w * 1.2} height={w * 1.2} />
                      ) : (
                        <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#f5e6c8">
                          {name}
                        </text>
                      )}
                      {row.remainingTurns > 0 ? (
                        <text
                          x={x + w * 0.5}
                          y={y - h * 0.6}
                          textAnchor="middle"
                          fontSize={12}
                          fontWeight={700}
                          fill="#fff"
                        >
                          {row.remainingTurns}
                        </text>
                      ) : null}
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <p className={styles.note}>빈 터 {empty}칸</p>
        </div>
        {land && chosen ? (
          <LotPicker key={chosen.id} land={land} slotId={chosen.id} onReserve={onReserve} layout="cards" />
        ) : (
          <ul className={styles.cards} aria-label="성 안에 지을 수 있는 건물">
            {INSIDE_BUILDINGS.map((building) => {
              const blocked = insideBlock(building, grade, cityName);
              const url = icon(building.icon);
              return (
                <li
                  key={building.icon}
                  className={`kit-card ${styles.card}`}
                  data-blocked={blocked ? 'true' : undefined}
                >
                  {url ? <img src={url} alt="" className={styles.icon} /> : null}
                  <b>{building.name}</b>
                  <span className={styles.effect}>{building.effect}</span>
                  {blocked ? (
                    <span className={styles.blocked}>{blocked}</span>
                  ) : building.limit?.kind === 'onePerCity' ? (
                    <span className={styles.limit}>도시당 1</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
