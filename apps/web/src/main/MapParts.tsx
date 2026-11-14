// SVG 지도와 3D 지도가 함께 쓰는 지도 부품 (INT-27 1단계). 풍선과 지도 거점 고르기 상자다.
import type { CSSProperties } from 'react';
import { MapGenerals } from './MapGenerals';
import {
  chooserGroups,
  SITE_KIND_LABELS,
  SITE_SHORT_LABELS,
  type MapModel,
  type MapSite,
  type SiteView,
} from './mapModel';
import styles from './OperationalWorldMap.module.css';

// 마우스를 올린 거점의 풍선. 내용은 읽기 이름과 같다(호버 전용 정보 없음).
export function MapTooltip({ view, model, style }: { view: SiteView; model: MapModel; style: CSSProperties }) {
  const { site, city, nation, grade, owner, notes } = view;
  return (
    <div className={styles.tooltip} data-testid="map-tooltip" aria-hidden="true" style={style}>
      <p className={styles.tooltipTitle}>
        <span>{site.name}</span>
        {/* 원작 도시 제목처럼 지역·규모를 함께 쓴다 (【 하북 · 특 】). */}
        <span className={styles.tooltipGrade}>
          {city?.regionName ? `${city.regionName} · ` : ''}
          {grade ?? SITE_SHORT_LABELS[site.kind]}
        </span>
      </p>
      {owner ? (
        <p className={styles.tooltipOwner}>
          <span className={styles.tooltipSwatch} style={{ background: nation?.color ?? '#d6d0c4' }} />
          {owner}
        </p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className={styles.tooltipNote}>
          {note}
        </p>
      ))}
      {city ? <MapGenerals generals={model.generalsAt.get(city.key) ?? []} /> : null}
    </div>
  );
}

// 커서 오른쪽 아래에 띄우되 지도 밖으로 나가면 왼쪽·위로 넘긴다.
export function tooltipPlacement(
  hover: { x: number; y: number },
  frame: { width: number; height: number },
): CSSProperties {
  const right = hover.x > frame.width - 200;
  const below = hover.y < 120;
  return {
    left: right ? undefined : hover.x + 14,
    right: right ? Math.max(0, frame.width - hover.x + 14) : undefined,
    top: below ? hover.y + 18 : undefined,
    bottom: below ? undefined : Math.max(0, frame.height - hover.y + 10),
  };
}

// 지도 거점 고르기. 내 국가를 주면 본국·타국·공백지로 묶는다 (INT-25).
export function MapSiteChooser({
  model,
  selectedKey,
  myNationId,
  onChoose,
}: {
  model: MapModel;
  selectedKey: number | null;
  myNationId: number | null | undefined;
  onChoose: (key: number) => void;
}) {
  const option = (site: MapSite, tag?: string) => (
    <option key={site.id} value={site.anchorKey}>
      {site.name} ({SITE_KIND_LABELS[site.kind]}){tag ? ` · ${tag}` : ''}
    </option>
  );
  return (
    <label className={styles.selector}>
      지도 거점
      <select value={selectedKey ?? ''} onChange={(event) => onChoose(Number(event.target.value))}>
        <option value="" disabled>
          도시·관문 선택
        </option>
        {myNationId === undefined
          ? model.anchors.map((site) => option(site))
          : chooserGroups(model.anchors, model.cityByKey, myNationId).map((group) => (
              <optgroup key={group.tag} label={group.tag}>
                {group.sites.map((site) => option(site, group.tag))}
              </optgroup>
            ))}
      </select>
    </label>
  );
}
