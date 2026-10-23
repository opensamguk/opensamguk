import { useEffect, useReducer, useRef } from 'react';
import type { MapCity } from '../game/types';
import { MAP_HEIGHT, MAP_WIDTH, mapLinks } from '../main/WorldMap';
import { EmptyState } from '../ui/States';
import {
  frameDate,
  frameView,
  type FrameCityView,
  type LegendEntry,
  type NationDisplaySource,
  type TimelapseFrame,
} from './frames';
import { initialPlayback, isWaiting, playback } from './playback';
import styles from './Timelapse.module.css';

// 공백지 색. 메인 지도(WorldMap.tsx)와 같은 값이다.
const NEUTRAL = '#d6d0c4';
const STEP_MS = 1000;
const DOT_R = 6;
const CONTRACT_ERROR = '기록 순서가 맞지 않아 더 불러오지 않았습니다.';

// 월간 영토 재생. 프레임·지도 좌표·과거 표시값 출처를 받아 그린다. 조회와 진입점은 부모가 맡는다.
// 두 달의 소유 차이로 사건 문구를 만들지 않고 지금 국가 행 값도 쓰지 않는다.
export function TimelapseView({
  frames,
  map,
  source,
  hasMore,
  nextError,
  onRetryNext,
  contractError,
}: {
  frames: readonly TimelapseFrame[];
  map: readonly MapCity[];
  source: NationDisplaySource;
  hasMore: boolean;
  nextError: boolean;
  onRetryNext: () => void;
  contractError: 'order' | 'cursor' | null;
}) {
  const [state, dispatch] = useReducer(playback, initialPlayback);
  const count = frames.length;
  // 타이머는 재생을 켜고 끌 때만 다시 건다. 그 사이 늘어난 프레임 수는 ref로 읽는다.
  const live = useRef({ count, hasMore });
  useEffect(() => {
    live.current = { count, hasMore };
  });
  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => dispatch({ type: 'tick', ...live.current }), STEP_MS);
    return () => clearInterval(timer);
  }, [state.playing]);

  const index = Math.min(state.index, count - 1);
  const frame = frames[index];
  if (!frame) {
    // 첫 페이지부터 계약이 어긋나면 프레임이 0개여도 빈 기록이 아니다. 빈 상태보다 오류를 먼저 보인다.
    if (contractError) return <p className={styles.error}>{CONTRACT_ERROR}</p>;
    if (hasMore) return <p className={styles.status}>다음 기록을 불러오는 중</p>;
    return <EmptyState title="영토 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다" />;
  }
  const view = frameView(frame, map, source);
  const date = frameDate(frame);
  const waiting = isWaiting(state, count, hasMore);
  const last = index >= count - 1;

  return (
    <section className={styles.timelapse} aria-label="영토 재생" data-frame-tick={frame.tick}>
      <p className={styles.note}>국가 이름과 색은 그 달에 기록된 값입니다.</p>
      <p className={`num ${styles.date}`} aria-live={state.playing ? 'off' : 'polite'} data-testid="timelapse-date">
        {date} ({index + 1}/{count}){view.kind === 'missing' ? ' 국가 기록 없음' : null}
      </p>
      {view.kind === 'missing' ? (
        <div className={styles.missing} data-state="missing-record">
          <p className={styles.missingTitle}>이 시점의 국가 기록이 없습니다.</p>
          <p>다른 달을 골라 주세요.</p>
        </div>
      ) : (
        <>
          <FrameMap date={date} cities={view.cities} />
          <FrameLegend legend={view.legend} empty={view.empty} />
        </>
      )}
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          disabled={index === 0}
          onClick={() => dispatch({ type: 'first' })}
        >
          처음
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={index === 0}
          onClick={() => dispatch({ type: 'prev' })}
        >
          이전
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.play}`}
          onClick={() => dispatch({ type: 'toggle', count, hasMore })}
        >
          {state.playing ? '정지' : '재생'}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={last}
          onClick={() => dispatch({ type: 'next', count })}
        >
          다음
        </button>
        <input
          type="range"
          className={styles.range}
          min={0}
          max={count - 1}
          value={index}
          aria-label="재생 위치"
          aria-valuetext={`${date} (${index + 1}/${count})`}
          onChange={(event) => dispatch({ type: 'seek', index: Number(event.target.value), count })}
        />
      </div>
      <p className={styles.status}>
        <span className="num">{count}개월 불러옴</span>
        {waiting ? <span>다음 기록을 불러오는 중</span> : null}
        {view.kind === 'ok' && view.offMap > 0 ? <span className="num">지도에 없는 도시 {view.offMap}곳</span> : null}
      </p>
      {contractError ? <p className={styles.error}>{CONTRACT_ERROR}</p> : null}
      {nextError ? (
        <p className={styles.error}>
          다음 기록을 불러오지 못했습니다.{' '}
          <button type="button" className={styles.button} onClick={onRetryNext}>
            다시 시도
          </button>
        </p>
      ) : null}
    </section>
  );
}

// 누를 수 없는 그림이다. 도시 점은 포커스를 받지 않고 이름은 title로만 둔다.
function FrameMap({ date, cities }: { date: string; cities: readonly FrameCityView[] }) {
  return (
    <svg
      className={styles.map}
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      role="img"
      aria-label={`${date} 영토 지도, 도시 ${cities.length}개`}
      data-testid="timelapse-map"
    >
      <rect className={styles.ground} width={MAP_WIDTH} height={MAP_HEIGHT} />
      <g aria-hidden="true">
        {mapLinks(cities.map(({ city }) => city)).map(([a, b]) => (
          <line key={`${a.key}-${b.key}`} className={styles.link} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        ))}
      </g>
      {cities.map(({ city, nation }) => {
        const owner = nation === null ? '기록 없음' : nation.kind === 'stored' ? nation.name : '공백지';
        return (
          <g
            key={city.key}
            data-city-key={city.key}
            data-nation-id={nation?.kind === 'stored' ? nation.id : ''}
            data-recorded={nation !== null}
          >
            <title>{`${city.name}, ${owner}`}</title>
            <circle
              className={nation === null ? `${styles.dot} ${styles.unrecorded}` : styles.dot}
              cx={city.x}
              cy={city.y}
              r={DOT_R}
              style={nation === null ? undefined : { fill: nation.kind === 'stored' ? nation.color : NEUTRAL }}
            />
            <text className={styles.label} x={city.x} y={city.y + DOT_R + 10}>
              {city.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// 색만으로 뜻을 전하지 않도록 국가 이름과 도시 수를 글자로 둔다.
function FrameLegend({ legend, empty }: { legend: readonly LegendEntry[]; empty: number }) {
  return (
    <div className={styles.legend} aria-label="이 달의 국가별 도시 수">
      {legend.map(({ nation, count }) => (
        <span key={nation.id} className={styles.legendItem} data-nation-id={nation.id}>
          <span className={styles.swatch} style={{ background: nation.color }} aria-hidden="true" />
          {nation.name} {count}
        </span>
      ))}
      <span className={styles.legendItem}>
        <span className={styles.swatch} style={{ background: NEUTRAL }} aria-hidden="true" />
        공백지 {empty}
      </span>
    </div>
  );
}
