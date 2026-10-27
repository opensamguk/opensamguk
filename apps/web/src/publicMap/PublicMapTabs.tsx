import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { MapLegend, WorldMap } from '../main/WorldMap';
import { useTRPC } from '../trpc';
import { Tag } from '../ui/Tag';
import { delayText, snapshotTimeText, toPublicMaps, type PublicMaps } from './publicMaps';
import styles from './PublicMapTabs.module.css';

// 사본은 엔진이 5분마다 찍는다(T2-24). 1분마다 다시 받으면 새 사본이 늦어도 1분 안에 보인다.
const REFRESH_MS = 60_000;

// 로그인 화면과 로비의 지연 공개 지도 (T2-25, D-026). 진행 중인 월드를 탭으로 고르고 지도는 하나만 그린다.
export function PublicMapTabs() {
  const trpc = useTRPC();
  const maps = useQuery(
    trpc.world.publicMaps.queryOptions(undefined, {
      select: toPublicMaps,
      staleTime: REFRESH_MS,
      refetchInterval: REFRESH_MS,
    }),
  );
  return <PublicMapView data={maps.data} failed={maps.isError && !maps.data} />;
}

// 공개할 월드가 없거나 아직 받는 중이면 문구 없이 자리만 둔다 (2026-10-23 소유자 지시).
export function PublicMapView({
  data,
  failed = false,
  now = new Date(),
}: {
  data: PublicMaps | undefined;
  failed?: boolean;
  now?: Date;
}) {
  const baseId = useId();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  if (failed) {
    return (
      <section className={styles.area} data-testid="public-map" aria-label="공개 지도">
        <p className={styles.note}>공개 지도를 불러오지 못했습니다</p>
      </section>
    );
  }
  const worlds = data?.worlds ?? [];
  if (!data || worlds.length === 0) return <div className={styles.area} data-testid="public-map" data-empty="true" />;

  // 고른 월드가 다시 받은 목록에서 빠지면 첫 탭으로 돌아간다.
  const index = Math.max(
    0,
    worlds.findIndex((world) => world.id === chosenId),
  );
  const current = worlds[index] ?? worlds[0]!;
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;

  const move = (event: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? worlds.length - 1
          : step === undefined
            ? null
            : (index + step + worlds.length) % worlds.length;
    if (target === null) return;
    event.preventDefault();
    const next = worlds[target]!;
    setChosenId(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <section className={styles.area} data-testid="public-map" aria-label="공개 지도">
      <div className={styles.tabs} role="tablist" aria-label="진행 중인 월드" onKeyDown={move}>
        {worlds.map((world, i) => {
          const selected = i === index;
          return (
            <button
              key={world.id}
              ref={(node) => {
                if (node) tabRefs.current.set(world.id, node);
                else tabRefs.current.delete(world.id);
              }}
              type="button"
              role="tab"
              id={tabId(i)}
              className={styles.tab}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setChosenId(world.id)}
            >
              {world.name}
              {world.status === 'PAUSED' ? <Tag tone="muted">멈춤</Tag> : null}
            </button>
          );
        })}
      </div>
      <div
        className={styles.panel}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(index)}
        data-world-id={current.id}
      >
        {current.map === null ? (
          <p className={styles.note}>아직 공개 지도가 없습니다</p>
        ) : (
          <>
            <p className={styles.when} data-testid="public-map-when">
              <time dateTime={current.map.takenAt}>{snapshotTimeText(current.map, now)}</time>
              {data.delayMinutes > 0 ? <span>{delayText(data.delayMinutes)}</span> : null}
            </p>
            <WorldMap
              key={current.id}
              cities={current.map.cities}
              nations={current.map.nations}
              operationalMap={current.map.operationalMap}
            />
            <MapLegend cities={current.map.cities} nations={current.map.nations} readOnly />
          </>
        )}
      </div>
    </section>
  );
}
