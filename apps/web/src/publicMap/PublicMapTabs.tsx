import { publicImageUrl } from '@opensamguk/shared/public-images';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
const mapIconUrl = publicImageUrl('apps/web/src/art/icons/map.png');
const basemapUrl = publicImageUrl('apps/web/src/main/san10-pixel-basemap.png');
import { MapLegend, WorldMap } from '../main/WorldMap';
import { useTRPC } from '../trpc';
import { Tag } from '../ui/Tag';
import { delayText, snapshotTimeText, toPublicMaps, type PublicMaps } from './publicMaps';
import styles from './PublicMapTabs.module.css';

// 사본은 엔진이 5분마다 찍는다(T2-24). 1분마다 다시 받으면 새 사본이 늦어도 1분 안에 보인다.
const REFRESH_MS = 60_000;

// 로그인 화면과 로비의 지연 공개 지도 (T2-25, D-026). 진행 중인 월드를 탭으로 고르고 지도는 하나만 그린다.
export function PublicMapTabs({ backdrop = false }: { backdrop?: boolean } = {}) {
  const trpc = useTRPC();
  const maps = useQuery(
    trpc.world.publicMaps.queryOptions(undefined, {
      select: toPublicMaps,
      staleTime: REFRESH_MS,
      refetchInterval: REFRESH_MS,
    }),
  );
  return <PublicMapView data={maps.data} failed={maps.isError && !maps.data} backdrop={backdrop} />;
}

// 공개할 월드가 없거나 아직 받는 중이면 문구 없이 자리만 둔다 (2026-10-23 소유자 지시).
export function PublicMapView({
  data,
  failed = false,
  now = new Date(),
  backdrop = false,
}: {
  data: PublicMaps | undefined;
  failed?: boolean;
  now?: Date;
  /** 로그인 화면 배경. 지도가 상자를 가득 채우고, 월드가 없으면 바탕 그림만 깐다. */
  backdrop?: boolean;
}) {
  const baseId = useId();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const worlds = data?.worlds ?? [];
  if (backdrop && (failed || !data || worlds.length === 0))
    return (
      <div className={styles.backdrop} data-testid="public-map" data-empty="true">
        <img className={styles.backdropImage} src={basemapUrl} alt="" />
      </div>
    );
  if (failed) {
    return (
      <section className={styles.area} data-testid="public-map" aria-label="공개 지도">
        <p className={styles.note}>공개 지도를 불러오지 못했습니다</p>
      </section>
    );
  }
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

  const tabRow = (
    <div className={backdrop ? `${styles.tabRow} ${styles.backdropBox}` : styles.tabRow}>
      <img className={styles.icon} src={mapIconUrl} alt="" width={32} height={32} />
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
    </div>
  );
  const snapshot = current.map;
  const when = snapshot ? (
    <p className={backdrop ? `${styles.when} ${styles.backdropBox}` : styles.when} data-testid="public-map-when">
      <time dateTime={snapshot.takenAt}>{snapshotTimeText(snapshot, now)}</time>
      {data.delayMinutes > 0 ? <span>{delayText(data.delayMinutes)}</span> : null}
    </p>
  ) : null;
  const legend = snapshot ? <MapLegend cities={snapshot.cities} nations={snapshot.nations} readOnly /> : null;
  const map = snapshot ? (
    <WorldMap
      key={current.id}
      cities={snapshot.cities}
      nations={snapshot.nations}
      operationalMap={snapshot.operationalMap}
      fill={backdrop}
    />
  ) : null;
  const panel = (children: ReactNode) => (
    <div
      className={backdrop ? styles.backdropPanel : styles.panel}
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId(index)}
      data-world-id={current.id}
    >
      {snapshot === null ? (
        <>
          {/* 새 월드는 첫 턴이 지나고 공개 지연이 끝날 때까지 사본이 없다. 그동안 로그인 배경이 빈 바다로 남지 않게 바탕 그림을 깐다. */}
          {backdrop ? (
            <img className={styles.backdropImage} src={basemapUrl} alt="" data-testid="public-map-basemap" />
          ) : null}
          <p className={backdrop ? `${styles.note} ${styles.backdropNote}` : styles.note}>아직 공개 지도가 없습니다</p>
        </>
      ) : (
        children
      )}
    </div>
  );

  // 로그인 배경: 탭·기준 시각·범례를 한 기둥에 위에서부터 쌓아 탭이 여러 줄이어도 아래 요소가 덮지 않는다.
  if (backdrop)
    return (
      <section className={styles.backdrop} data-testid="public-map" aria-label="공개 지도">
        <div className={styles.backdropStack}>
          {tabRow}
          {when}
          {legend ? (
            <details className={`${styles.backdropBox} ${styles.backdropLegend}`}>
              <summary>범례</summary>
              {legend}
            </details>
          ) : null}
        </div>
        {panel(map)}
      </section>
    );
  return (
    <section className={styles.area} data-testid="public-map" aria-label="공개 지도">
      {tabRow}
      {panel(
        <>
          {when}
          {map}
          {legend}
        </>,
      )}
    </section>
  );
}
