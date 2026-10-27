import { useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import {
  MAX_DRAFT_BYTES,
  ROUTE_MODES,
  SITE_KINDS,
  TERRAIN_KINDS,
  parseCampaignDraft,
  previewCampaignRoute,
  validateCampaignDraft,
  type CampaignDraft,
  type CampaignSite,
} from '@opensamguk/rules/resources';
import { createCampaignDraft } from './campaignSeed';
import { basemap, unprojectGeographicPoint } from './geography';
import reliefUrl from './geodata/natural-earth-relief.webp';
import cityMarker from './icons/city.png';
import passMarker from './icons/pass.png';
import portMarker from './icons/port.png';
import fieldMarker from './icons/field.png';
import styles from './CampaignMapEditor.module.css';

type History = { map: CampaignDraft; past: CampaignDraft[]; future: CampaignDraft[] };
type Action = { type: 'edit'; map: CampaignDraft } | { type: 'load'; map: CampaignDraft } | { type: 'undo' | 'redo' };
export function campaignHistory(state: History, action: Action): History {
  if (action.type === 'load') return { map: action.map, past: [], future: [] };
  if (action.type === 'edit') return { map: action.map, past: [...state.past.slice(-49), state.map], future: [] };
  if (action.type === 'undo' && state.past.length)
    return { map: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.map, ...state.future] };
  if (action.type === 'redo' && state.future.length)
    return { map: state.future[0]!, past: [...state.past, state.map], future: state.future.slice(1) };
  return state;
}
const labels = {
  CITY: '도시',
  PASS: '관문',
  PORT: '항구',
  FIELD: '전장',
  LAND: '육로',
  FORD: '도하',
  BRIDGE: '교량',
  RIVER: '수로',
  PLAIN: '평지',
  FOREST: '숲',
  MOUNTAIN: '산지',
  WATER: '물',
};
const siteIcons: Record<CampaignSite['kind'], string> = {
  CITY: cityMarker,
  PASS: passMarker,
  PORT: portMarker,
  FIELD: fieldMarker,
};
const terrainColors = { PLAIN: '#d8cda7', FOREST: '#647958', MOUNTAIN: '#8a8070', WATER: '#7cabb6' };
const nextId = (prefix: string, entries: { id: string }[], suffix = '') => {
  let n = 1;
  while (entries.some((e) => e.id === `${prefix}:${suffix}${n}`)) n++;
  return `${prefix}:${suffix}${n}`;
};

export function CampaignMapEditorPage() {
  const [state, dispatch] = useReducer(campaignHistory, undefined, () => ({
    map: createCampaignDraft(),
    past: [],
    future: [],
  }));
  const map = state.map;
  const [saved, setSaved] = useState(map);
  const [selected, setSelected] = useState('city:4');
  const [tool, setTool] = useState<'select' | 'site' | 'terrain' | 'place'>('select');
  const [kind, setKind] = useState<CampaignSite['kind']>('CITY');
  const [terrainKind, setTerrainKind] = useState<CampaignDraft['terrain'][number]['kind']>('MOUNTAIN');
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('city:4');
  const [to, setTo] = useState('city:3');
  const [allowRiver, setAllowRiver] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, w: 1000, h: 700 });
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [background, setBackground] = useState('');
  const [showRelief, setShowRelief] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const issues = useMemo(() => validateCampaignDraft(map), [map]);
  const hasErrors = issues.some((i) => i.severity === 'error');
  const preview = useMemo(() => previewCampaignRoute(map, from, to, allowRiver), [map, from, to, allowRiver]);
  const site = map.sites.find((s) => s.id === selected);
  const route = map.routes.find((r) => r.id === selected);
  const patch = map.terrain.find((t) => t.id === selected);
  const dirty = saved !== map;
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  useEffect(
    () => () => {
      if (background) URL.revokeObjectURL(background);
    },
    [background],
  );
  const edit = (next: CampaignDraft) => dispatch({ type: 'edit', map: next });
  const changeSite = (changes: Partial<CampaignSite>) => {
    if (site)
      edit({
        ...map,
        sites: map.sites.map((s) =>
          s.id === site.id
            ? {
                ...s,
                ...changes,
              }
            : s,
        ),
      });
  };
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(1000, Math.round(p.x))), y: Math.max(0, Math.min(700, Math.round(p.y))) };
  };
  const deleteSelected = () => {
    const removed = new Set([selected, ...map.sites.filter((s) => s.parentCityId === selected).map((s) => s.id)]);
    edit({
      ...map,
      sites: map.sites.filter((s) => !removed.has(s.id)),
      routes: map.routes.filter((r) => !removed.has(r.id) && !removed.has(r.from) && !removed.has(r.to)),
      terrain: map.terrain.filter((t) => t.id !== selected),
    });
    setSelected('');
  };
  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_DRAFT_BYTES) throw new Error('지도 파일은 2 MB 이하로 고르세요.');
      const next = parseCampaignDraft(await file.text());
      // Loading is undoable so an unsaved draft can always be recovered.
      edit(next);
      setSaved(next);
      setSelected(next.sites[0]?.id ?? '');
      setPoints([]);
      setFrom(next.sites[0]?.id ?? '');
      setTo(next.sites.at(-1)?.id ?? '');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일을 읽지 못했습니다.');
    }
  };
  const download = () => {
    if (hasErrors) return;
    const blob = new Blob([JSON.stringify(map, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'campaign-map-draft.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setSaved(map);
  };
  const addRoute = () => {
    if (from === to || !map.sites.some((s) => s.id === from) || !map.sites.some((s) => s.id === to)) {
      setError('서로 다른 출발·도착 거점을 고르세요.');
      return;
    }
    const id = nextId('route', map.routes);
    edit({
      ...map,
      routes: [...map.routes, { id, from, to, mode: 'LAND', direction: 'BOTH', enabled: true }],
    });
    setSelected(id);
    setError('');
  };
  const zoom = (scale: number) =>
    setView((v) => {
      const w = Math.max(125, Math.min(1000, v.w * scale));
      const h = w * 0.7;
      return {
        x: Math.max(0, Math.min(1000 - w, v.x + (v.w - w) / 2)),
        y: Math.max(0, Math.min(700 - h, v.y + (v.h - h) / 2)),
        w,
        h,
      };
    });
  const pan = (dx: number, dy: number) =>
    setView((v) => ({
      ...v,
      x: Math.max(0, Math.min(1000 - v.w, v.x + (dx * v.w) / 4)),
      y: Math.max(0, Math.min(700 - v.h, v.y + (dy * v.h) / 4)),
    }));
  const siteOptions = map.sites.map((s) => (
    <option value={s.id} key={s.id}>
      {s.name} · {labels[s.kind]} ({s.id})
    </option>
  ));
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <a href="/dev/map-editor">기존 v2 편집기</a>
          <h1>통합 지도 편집기</h1>
          <p>
            {map.sites.filter((s) => s.kind === 'CITY').length}도시 초안 ·{' '}
            {dirty ? '내보내지 않은 변경 있음' : '파일 상태와 같음'}
          </p>
        </div>
        <div className={styles.toolbar}>
          <label className={styles.file}>
            v3 파일 불러오기
            <input
              aria-label="v3 파일 불러오기"
              type="file"
              accept=".json,application/json"
              onChange={(e) => void load(e)}
            />
          </label>
          <button onClick={download} disabled={hasErrors}>
            JSON 내보내기
          </button>
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!state.past.length}>
            되돌리기
          </button>
          <button onClick={() => dispatch({ type: 'redo' })} disabled={!state.future.length}>
            다시 적용
          </button>
        </div>
      </header>
      <p className={styles.notice}>
        파일 편집용 개발 화면입니다. 실제 지리 데이터는 Natural Earth v5.1.2이며 운영 DB에 저장하지 않습니다. 거점은
        게임에 맞게 편집할 수 있습니다. 초기 경로는 비어 있습니다.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.layout}>
        <section className={styles.canvasSection} aria-label="지도 작업 영역">
          <div className={styles.toolbar}>
            <label>
              도구
              <select
                value={tool}
                onChange={(e) => {
                  setTool(e.target.value as typeof tool);
                  setPoints([]);
                }}
              >
                <option value="select">선택·이동</option>
                <option value="site">거점 추가</option>
                <option value="terrain">지형 그리기</option>
                <option value="place">선택 거점 배치</option>
              </select>
            </label>
            {tool === 'site' && (
              <label>
                새 거점 종류
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {SITE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {labels[k]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tool === 'terrain' && (
              <>
                <label>
                  새 지형
                  <select value={terrainKind} onChange={(e) => setTerrainKind(e.target.value as typeof terrainKind)}>
                    {TERRAIN_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {labels[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={points.length < 3}
                  onClick={() => {
                    const id = nextId('terrain', map.terrain);
                    edit({ ...map, terrain: [...map.terrain, { id, kind: terrainKind, points }] });
                    setPoints([]);
                    setSelected(id);
                    setTool('select');
                  }}
                >
                  지형 확정 ({points.length}점)
                </button>
                <button onClick={() => setPoints([])}>점 지우기</button>
              </>
            )}
          </div>
          <div className={styles.toolbar}>
            <button aria-label="확대" onClick={() => zoom(0.7)}>
              확대
            </button>
            <button aria-label="축소" onClick={() => zoom(1 / 0.7)}>
              축소
            </button>
            <button onClick={() => setView({ x: 0, y: 0, w: 1000, h: 700 })}>전체 보기</button>
            <button aria-label="서쪽 보기" onClick={() => pan(-1, 0)}>
              서
            </button>
            <button aria-label="동쪽 보기" onClick={() => pan(1, 0)}>
              동
            </button>
            <button aria-label="북쪽 보기" onClick={() => pan(0, -1)}>
              북
            </button>
            <button aria-label="남쪽 보기" onClick={() => pan(0, 1)}>
              남
            </button>
            <label className={styles.file}>
              참고 밑그림
              <input
                aria-label="참고 밑그림"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size <= 20_000_000)
                    setBackground(URL.createObjectURL(file));
                  else setError('밑그림은 20 MB 이하 이미지로 고르세요.');
                  e.target.value = '';
                }}
              />
            </label>
            {background && <button onClick={() => setBackground('')}>밑그림 숨기기</button>}
          </div>
          <label>
            <input type="checkbox" checked={showRelief} onChange={(e) => setShowRelief(e.target.checked)} />
            실제 지형 음영
          </label>
          <p className={styles.help}>
            Natural Earth 실제 지형 · WGS84. 거점 배치는 게임에 맞게 편집할 수 있습니다. 모든 거점을 같은 방식으로
            표시합니다.
          </p>
          <svg
            ref={svgRef}
            className={styles.canvas}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            role="img"
            aria-label="통합 지도 캔버스"
            onPointerMove={(e) => {
              if (drag) {
                const p = position(e);
                if (p) setDrag({ id: drag.id, ...p });
              }
            }}
            onPointerCancel={() => setDrag(null)}
            onPointerUp={(e) => {
              const p = position(e);
              if (!p) {
                setDrag(null);
                return;
              }
              if (drag) {
                const current = map.sites.find((s) => s.id === drag.id);
                if (current && (current.x !== p.x || current.y !== p.y))
                  edit({
                    ...map,
                    sites: map.sites.map((s) => (s.id === drag.id ? { ...s, ...p } : s)),
                  });
                setDrag(null);
                return;
              }
              if (e.target !== e.currentTarget && !(e.target as Element).hasAttribute('data-background')) return;
              if (tool === 'terrain') setPoints([...points, p]);
              if (tool === 'place' && site) {
                changeSite(p);
                setTool('select');
              }
              if (tool === 'site') {
                const id = nextId(kind.toLowerCase(), map.sites, 'custom-');
                const parent =
                  site?.kind === 'CITY'
                    ? site
                    : map.sites
                        .filter((s) => s.kind === 'CITY')
                        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
                edit({
                  ...map,
                  sites: [
                    ...map.sites,
                    {
                      id,
                      name: `새 ${labels[kind]}`,
                      kind,
                      ...p,
                      ...(kind === 'PORT' && parent ? { parentCityId: parent.id } : {}),
                    },
                  ],
                });
                setSelected(id);
                setTool('select');
              }
            }}
          >
            <title>통합 지도 초안. 목록과 좌표 입력으로도 편집할 수 있습니다.</title>
            <defs>
              <marker
                id="campaign-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5L0 10" fill="context-stroke" />
              </marker>
            </defs>
            <rect data-background="true" width="1000" height="700" fill="#d5e5e7" />
            <g data-testid="geographic-basemap" pointerEvents="none">
              {showRelief && (
                <image
                  data-testid="geographic-relief"
                  href={reliefUrl}
                  width="1000"
                  height="700"
                  preserveAspectRatio="none"
                />
              )}
              {basemap.land.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="#e6dfc9"
                  fillOpacity={showRelief ? 0 : 1}
                  stroke="#8e9c8d"
                  strokeWidth=".4"
                  fillRule="evenodd"
                />
              ))}
              {basemap.lakes.map((d, i) => (
                <path key={i} d={d} fill="#a9c9d2" stroke="#8ab0bc" strokeWidth=".3" fillRule="evenodd" />
              ))}
              {basemap.rivers.map((r, i) => (
                <path key={i} d={r.path} fill="none" stroke="#6d9dad" strokeWidth={r.rank <= 3 ? 1.15 : 0.55} />
              ))}
            </g>
            {background && (
              <image
                data-background="true"
                href={background}
                width="1000"
                height="700"
                opacity=".55"
                preserveAspectRatio="none"
              />
            )}
            {map.terrain.map((t) => (
              <polygon
                key={t.id}
                data-background={tool !== 'select' ? 'true' : undefined}
                data-testid={t.id}
                points={t.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={terrainColors[t.kind]}
                opacity=".65"
                stroke={selected === t.id ? '#a43f24' : '#645c4b'}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    setSelected(t.id);
                  }
                }}
              />
            ))}
            {map.routes.map((r) => {
              const a = map.sites.find((s) => s.id === r.from);
              const b = map.sites.find((s) => s.id === r.to);
              if (!a || !b) return null;
              return (
                <g
                  key={r.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected(r.id);
                  }}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth="14" />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      selected === r.id || preview?.routes.includes(r.id)
                        ? '#a43f24'
                        : r.mode === 'RIVER'
                          ? '#246b86'
                          : '#746344'
                    }
                    strokeWidth={preview?.routes.includes(r.id) ? 4 : 2}
                    strokeDasharray={r.enabled ? undefined : '5 5'}
                    markerEnd={r.direction === 'FORWARD' ? 'url(#campaign-arrow)' : undefined}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
            {points.length > 0 && (
              <polyline
                points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="#a43f24"
                strokeWidth="2"
                pointerEvents="none"
              />
            )}
            {map.sites.map((s) => {
              const p = drag?.id === s.id ? drag : s;
              return (
                <g
                  data-testid={s.id}
                  key={s.id}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected(s.id);
                    if (tool === 'select') {
                      svgRef.current?.setPointerCapture(e.pointerId);
                      setDrag({ id: s.id, x: s.x, y: s.y });
                    }
                  }}
                  className={styles.site}
                >
                  <rect x="-13" y="-27" width="26" height="30" fill="transparent" />
                  <image
                    data-testid={`site-icon-${s.kind.toLowerCase()}`}
                    className={styles.pixelMarker}
                    href={siteIcons[s.kind]}
                    x="-12"
                    y="-23.25"
                    width="24"
                    height="24"
                    pointerEvents="none"
                  />
                  {selected === s.id && (
                    <rect
                      x="-14"
                      y="-27"
                      width="28"
                      height="30"
                      fill="none"
                      stroke="#ac3f22"
                      strokeWidth="1.5"
                      pointerEvents="none"
                    />
                  )}
                  {(s.kind === 'CITY' || selected === s.id || view.w < 650) && (
                    <text
                      x="14"
                      y="-14"
                      fontSize="11"
                      fill="#28251e"
                      paintOrder="stroke"
                      stroke="#eee5cf"
                      strokeWidth="2"
                    >
                      {s.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className={styles.legend}>
            {SITE_KINDS.map((k) => (
              <span key={k}>
                <img src={siteIcons[k]} alt="" />
                {labels[k]}
              </span>
            ))}
          </div>
          <p className={styles.help}>
            거점을 끌거나 좌표로 이동합니다. 지형은 점 3개 이상을 찍어 확정합니다. 지형 그림은 이동 규칙을 바꾸지
            않습니다. 밑그림은 JSON에 포함하지 않습니다.
          </p>
        </section>
        <aside className={styles.sidebar}>
          <section>
            <h2>선택과 편집</h2>
            <label>
              대상
              <select aria-label="편집 대상" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">선택 없음</option>
                {siteOptions}
                {map.routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {labels[r.mode]}
                  </option>
                ))}
                {map.terrain.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {labels[t.kind]}
                  </option>
                ))}
              </select>
            </label>
            {site && (
              <>
                <p>
                  {labels[site.kind]} · {site.id}
                  {site.legacyCityId ? ` · 도시 키 ${site.legacyCityId}` : ''}
                </p>
                <label>
                  거점 이름
                  <input value={site.name} maxLength={60} onChange={(e) => changeSite({ name: e.target.value })} />
                </label>
                <div className={styles.pair}>
                  {(['x', 'y'] as const).map((axis) => (
                    <label key={axis}>
                      {axis.toUpperCase()} 좌표
                      <input
                        type="number"
                        min="0"
                        max={axis === 'x' ? 1000 : 700}
                        value={Number.isFinite(site[axis]) ? site[axis] : ''}
                        onChange={(e) => changeSite({ [axis]: e.target.valueAsNumber })}
                      />
                    </label>
                  ))}
                </div>
                {site.kind === 'PORT' && (
                  <label>
                    소속 도시
                    <select
                      value={site.parentCityId ?? ''}
                      onChange={(e) => changeSite({ parentCityId: e.target.value })}
                    >
                      <option value="">선택</option>
                      {map.sites
                        .filter((s) => s.kind === 'CITY')
                        .map((s) => (
                          <option value={s.id} key={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <p className={styles.help}>
                  경도 {unprojectGeographicPoint(site.x, site.y).longitude.toFixed(3)} · 위도{' '}
                  {unprojectGeographicPoint(site.x, site.y).latitude.toFixed(3)}
                </p>
                <p className={styles.help}>종류와 ID는 유지합니다. 다른 종류는 새 거점으로 추가하세요.</p>
              </>
            )}
            {route && (
              <>
                <p>{route.id}</p>
                <label>
                  경로 출발
                  <select
                    value={route.from}
                    onChange={(e) =>
                      edit({
                        ...map,
                        routes: map.routes.map((r) => (r.id === route.id ? { ...r, from: e.target.value } : r)),
                      })
                    }
                  >
                    {siteOptions}
                  </select>
                </label>
                <label>
                  경로 도착
                  <select
                    value={route.to}
                    onChange={(e) =>
                      edit({
                        ...map,
                        routes: map.routes.map((r) => (r.id === route.id ? { ...r, to: e.target.value } : r)),
                      })
                    }
                  >
                    {siteOptions}
                  </select>
                </label>
                <label>
                  이동 방식
                  <select
                    value={route.mode}
                    onChange={(e) =>
                      edit({
                        ...map,
                        routes: map.routes.map((r) =>
                          r.id === route.id ? { ...r, mode: e.target.value as typeof r.mode } : r,
                        ),
                      })
                    }
                  >
                    {ROUTE_MODES.map((k) => (
                      <option key={k} value={k}>
                        {labels[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  방향
                  <select
                    value={route.direction}
                    onChange={(e) =>
                      edit({
                        ...map,
                        routes: map.routes.map((r) =>
                          r.id === route.id ? { ...r, direction: e.target.value as typeof r.direction } : r,
                        ),
                      })
                    }
                  >
                    <option value="BOTH">양방향</option>
                    <option value="FORWARD">출발 → 도착</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={route.enabled}
                    onChange={(e) =>
                      edit({
                        ...map,
                        routes: map.routes.map((r) => (r.id === route.id ? { ...r, enabled: e.target.checked } : r)),
                      })
                    }
                  />
                  경로 활성
                </label>
              </>
            )}
            {patch && (
              <>
                <p>
                  {patch.id} · {labels[patch.kind]}
                </p>
                <label>
                  지형 종류
                  <select
                    value={patch.kind}
                    onChange={(e) =>
                      edit({
                        ...map,
                        terrain: map.terrain.map((t) =>
                          t.id === patch.id ? { ...t, kind: e.target.value as typeof t.kind } : t,
                        ),
                      })
                    }
                  >
                    {TERRAIN_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {labels[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <p>{patch.points.length}개 꼭짓점. 다시 그릴 때는 삭제 후 추가합니다.</p>
              </>
            )}
            {(site || route || patch) && (
              <button className={styles.danger} onClick={deleteSelected}>
                선택 삭제
              </button>
            )}
            {site?.kind === 'CITY' && (
              <p className={styles.help}>
                도시 삭제 시 소속 항구와 연결 경로도 지웁니다. 되돌리기로 복구할 수 있습니다.
              </p>
            )}
          </section>
          <section>
            <h2>거점 연결 확인</h2>
            <label>
              출발
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {siteOptions}
              </select>
            </label>
            <label>
              도착
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {siteOptions}
              </select>
            </label>
            <button onClick={addRoute}>두 거점 경로 추가</button>
            <label>
              <input type="checkbox" checked={allowRiver} onChange={(e) => setAllowRiver(e.target.checked)} />
              수로 포함
            </label>
            <p role="status" data-testid="route-preview">
              {preview
                ? `${preview.routes.length}개 연결 구간\n${preview.sites.map((id) => map.sites.find((s) => s.id === id)?.name).join(' → ')}`
                : '이 조건으로 이동할 경로가 없습니다.'}
            </p>
            <p className={styles.help}>
              연결 확인용입니다. 실제 이동은 main의 기존 이동 규칙을 유지합니다. 이동 기간·속도·거리 비용은 계산하지
              않습니다.
            </p>
          </section>
          <section>
            <h2>검사</h2>
            <p>
              {SITE_KINDS.map((k) => `${labels[k]} ${map.sites.filter((s) => s.kind === k).length}`).join(' · ')} · 경로{' '}
              {map.routes.length}
            </p>
            <p>{hasErrors ? '오류를 고쳐야 내보낼 수 있습니다.' : '파일 형식 검사 통과'}</p>
            <ul className={styles.issues}>
              {issues.slice(0, 12).map((i, n) => (
                <li key={n} className={i.severity === 'error' ? styles.error : ''}>
                  {i.message}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
