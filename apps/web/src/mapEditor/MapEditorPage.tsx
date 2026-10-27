import { useEffect, useMemo, useReducer, useState, type ChangeEvent, type Dispatch } from 'react';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState } from '../ui/States';
import {
  isClosedPolygon,
  layerLabel,
  linePoints,
  parseMapJson,
  serializeMap,
  SKETCH_PALETTE,
  TERRAIN_LAYERS,
  type MapV2,
  type Point,
  type TerrainLayer,
} from './contract';
import { clampPoint, editorReducer, initialEditor, isLinked, type EditorAction, type EditorState } from './editor';
import { fullView, MapCanvas, MAX_ZOOM, zoomView, type Tool, type View } from './MapCanvas';
import styles from './MapEditor.module.css';
import { encodeSketchPng, rasterizeSketch, SKETCH_SCALE } from './sketch';
import { LEVEL_RANGE, REGION_RANGE, validateMap, type Issue } from './validate';

// 지도 편집기 (T4-80). 서버 없이 파일로 불러오고 내려받는다. 관리자 콘솔 연결은 T4-81이다.
export function MapEditorPage() {
  const [loaded, setLoaded] = useState<{ map: MapV2; fileName: string; legacy: boolean; serial: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const result = parseMapJson(await file.text());
    if (!result.ok) {
      setError(`지도 파일을 불러오지 못했습니다 (${file.name}). ${result.error}`);
      return;
    }
    setError(null);
    setLoaded((previous) => ({
      map: result.map,
      fileName: file.name,
      legacy: result.legacy,
      serial: (previous?.serial ?? 0) + 1,
    }));
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>지도 편집기</h1>
        <a href="/dev/campaign-map-editor">통합 지도 편집기 v3</a>
        <p className={styles.muted}>
          개발 화면입니다. 서버에 저장하지 않고 파일로 불러오고 내려받습니다. 지금 형식과 v2 지도 JSON을 읽습니다.
        </p>
        <label className={styles.fileButton}>
          지도 파일 불러오기
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => void onFile(event)}
            data-testid="map-file"
          />
        </label>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </header>
      {loaded ? (
        <Editor key={loaded.serial} initial={loaded.map} fileName={loaded.fileName} legacy={loaded.legacy} />
      ) : (
        <EmptyState title="불러온 지도가 없습니다">지도 JSON 파일을 고르면 편집을 시작합니다.</EmptyState>
      )}
    </main>
  );
}

const TOOLS: ReadonlyArray<{ tool: Tool; label: string }> = [
  { tool: 'select', label: '선택' },
  { tool: 'city', label: '도시 추가' },
  { tool: 'link', label: '연결' },
  ...TERRAIN_LAYERS.map(({ layer, label }) => ({ tool: layer, label })),
];

const TOOL_HINT: Record<Tool, string> = {
  select: '도시나 선을 누르면 고릅니다. 도시와 고른 선의 점은 끌어서 옮깁니다. 빈 곳을 끌면 화면이 움직입니다.',
  city: '빈 곳을 누르면 그 자리에 도시를 만듭니다.',
  link: '도시 하나를 누르고 다른 도시를 누르면 잇습니다. 이미 이어져 있으면 끊습니다.',
  coast: '누를 때마다 점을 찍습니다. 해안 안쪽이 땅이 됩니다.',
  lakes: '누를 때마다 점을 찍습니다.',
  mountains: '누를 때마다 점을 찍습니다.',
  rivers: '누를 때마다 점을 찍습니다. 강은 열린 선입니다.',
};

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Editor({ initial, fileName, legacy }: { initial: MapV2; fileName: string; legacy: boolean }) {
  const [state, dispatch] = useReducer(editorReducer, initial, initialEditor);
  const { map, selection } = state;
  const [tool, setTool] = useState<Tool>('select');
  const [drawing, setDrawing] = useState<Point[]>([]);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [view, setView] = useState<View>(() => fullView(initial));
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validateMap(map), [map]);
  // 도시가 지워지거나 되돌려지면 번호가 밀리므로 연결 시작점을 푼다.
  useEffect(() => setLinkFrom(null), [map.cities.length]);

  const drawingLayer = tool === 'select' || tool === 'city' || tool === 'link' ? null : tool;
  const minPoints = drawingLayer === 'rivers' ? 2 : 3;
  const finishDrawing = () => {
    if (drawingLayer && drawing.length >= minPoints)
      dispatch({ type: 'addTerrain', layer: drawingLayer, points: drawing });
    setDrawing([]);
  };
  const chooseTool = (next: Tool) => {
    setTool(next);
    setDrawing([]);
    setLinkFrom(null);
  };

  const onLinkClick = (index: number | null) => {
    if (index === null || linkFrom === index) return setLinkFrom(null);
    if (linkFrom === null) {
      setLinkFrom(index);
      dispatch({ type: 'select', selection: { kind: 'city', index } });
      return;
    }
    dispatch({ type: 'toggleLink', a: linkFrom, b: index });
    dispatch({ type: 'select', selection: { kind: 'city', index } });
    setLinkFrom(null);
  };

  // 키보드: Ctrl+Z 되돌리기, Ctrl+Shift+Z·Ctrl+Y 다시 하기, Enter 그리기 마치기, Esc 그리기·연결 취소, Delete 고른 것 지우기.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
        if (typing) return;
        event.preventDefault();
        dispatch({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (typing) return;
      // 버튼에 초점이 있어도 Enter는 그리기를 마치는 데만 쓴다.
      if (event.key === 'Enter' && drawing.length > 0) {
        event.preventDefault();
        finishDrawing();
      } else if (event.key === 'Escape') {
        setDrawing([]);
        setLinkFrom(null);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && event.target === document.body) {
        if (selection?.kind === 'city') dispatch({ type: 'deleteCity', index: selection.index });
        else if (selection?.kind === 'terrain' && selection.point !== null)
          dispatch({
            type: 'deleteTerrainPoint',
            layer: selection.layer,
            index: selection.index,
            point: selection.point,
          });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exportSketch = async () => {
    setBusy(true);
    try {
      download(`${map.id}-sketch.png`, (await encodeSketchPng(rasterizeSketch(map))) as BlobPart, 'image/png');
    } finally {
      setBusy(false);
    }
  };

  const zoomPercent = Math.round((map.canvas.width / view.w) * 100);
  return (
    <div className={styles.editor}>
      <p className={styles.meta} data-testid="map-meta">
        {fileName} · {map.name} ({map.id}) · 도시 <span className="num">{map.cities.length}</span>개 · 캔버스{' '}
        {map.canvas.width}×{map.canvas.height} · 불러온 형식 {legacy ? '지금 형식' : 'v2'}
      </p>
      <div className={styles.toolbar}>
        <div className={styles.group} role="group" aria-label="편집 기록">
          {state.past.length > 0 ? (
            <button type="button" onClick={() => dispatch({ type: 'undo' })}>
              되돌리기
            </button>
          ) : (
            <DisabledReason reason="되돌릴 편집이 없습니다">되돌리기</DisabledReason>
          )}
          {state.future.length > 0 ? (
            <button type="button" onClick={() => dispatch({ type: 'redo' })}>
              다시 하기
            </button>
          ) : (
            <DisabledReason reason="다시 할 편집이 없습니다">다시 하기</DisabledReason>
          )}
        </div>
        <div className={styles.group} role="group" aria-label="내려받기">
          <button type="button" onClick={() => download(`${map.id}-v2.json`, serializeMap(map), 'application/json')}>
            v2 JSON 내려받기
          </button>
          <button type="button" onClick={() => void exportSketch()} disabled={busy}>
            {busy ? '밑그림 만드는 중' : '밑그림 PNG 내려받기'}
          </button>
          <span className={styles.muted} data-testid="export-note">
            {issues.length > 0
              ? `검증 오류 ${issues.length}건이 있어도 내려받습니다. 게시는 서버 검증을 지나야 합니다.`
              : '검증 오류 없음'}
          </span>
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.group} role="group" aria-label="도구">
          {TOOLS.map(({ tool: value, label }) => (
            <button key={value} type="button" aria-pressed={tool === value} onClick={() => chooseTool(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label="화면 배율">
          <button
            type="button"
            onClick={() => setView(zoomView(map, view, 1.5))}
            disabled={view.w <= map.canvas.width / MAX_ZOOM}
          >
            확대
          </button>
          <button
            type="button"
            onClick={() => setView(zoomView(map, view, 1 / 1.5))}
            disabled={view.w >= map.canvas.width}
          >
            축소
          </button>
          <button type="button" onClick={() => setView(fullView(map))}>
            전체 보기
          </button>
          <span className="num" data-testid="zoom">
            {zoomPercent}%
          </span>
        </div>
      </div>
      <p className={styles.hint} data-testid="tool-hint">
        {TOOL_HINT[tool]}
        {tool === 'link' && linkFrom !== null ? ` ${map.cities[linkFrom]?.name}에서 시작합니다.` : ''}
      </p>
      {drawingLayer ? (
        <div className={styles.drawingBar} role="group" aria-label="그리기">
          <span>
            {layerLabel(drawingLayer)} 점 <span className="num">{drawing.length}</span>개
          </span>
          {drawing.length >= minPoints ? (
            <button type="button" onClick={finishDrawing}>
              그리기 마치기
            </button>
          ) : (
            <DisabledReason reason={`점을 ${minPoints}개 이상 찍어야 합니다`}>그리기 마치기</DisabledReason>
          )}
          <button type="button" onClick={() => setDrawing([])} disabled={drawing.length === 0}>
            그리기 취소
          </button>
        </div>
      ) : null}
      <div className={styles.body}>
        <div className={styles.canvasWrap}>
          <MapCanvas
            map={map}
            selection={selection}
            tool={tool}
            drawing={drawing}
            linkFrom={linkFrom}
            view={view}
            dispatch={dispatch}
            onView={setView}
            onAddPoint={(x, y) => setDrawing((points) => [...points, clampPoint(map, x, y)])}
            onLinkClick={onLinkClick}
          />
          <SketchLegend />
        </div>
        <aside className={styles.side}>
          <SelectionPanel state={state} dispatch={dispatch} />
          <IssueList issues={issues} map={map} dispatch={dispatch} />
        </aside>
      </div>
    </div>
  );
}

function SketchLegend() {
  return (
    <div className={styles.legend} aria-label="지형 색">
      {SKETCH_PALETTE.map(({ name, color }) => (
        <span key={name} className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: color }} aria-hidden="true" />
          {name}
        </span>
      ))}
    </div>
  );
}

function SelectionPanel({ state, dispatch }: { state: EditorState; dispatch: Dispatch<EditorAction> }) {
  const { map, selection } = state;
  return (
    <section className={styles.panel} aria-labelledby="selection-title">
      <h2 id="selection-title">고른 것</h2>
      <label className={styles.field}>
        도시 찾기
        <select
          value={selection?.kind === 'city' ? selection.index : ''}
          onChange={(event) =>
            dispatch({
              type: 'select',
              selection: event.target.value === '' ? null : { kind: 'city', index: Number(event.target.value) },
            })
          }
        >
          <option value="">고르지 않음</option>
          {map.cities.map((city, index) => (
            <option key={index} value={index}>
              {city.name} (ID {city.id})
            </option>
          ))}
        </select>
      </label>
      {selection?.kind === 'city' && map.cities[selection.index] ? (
        <CityPanel
          key={`${selection.index}-${map.cities[selection.index]!.id}`}
          map={map}
          index={selection.index}
          dispatch={dispatch}
        />
      ) : selection?.kind === 'terrain' ? (
        <TerrainPanel
          map={map}
          layer={selection.layer}
          index={selection.index}
          point={selection.point}
          dispatch={dispatch}
        />
      ) : (
        <p className={styles.muted}>캔버스에서 도시나 선을 누르면 여기서 고칩니다.</p>
      )}
    </section>
  );
}

// 입력은 Enter나 칸을 떠날 때 편집 하나로 보낸다. 글자마다 되돌리기 기록이 쌓이지 않게 한다.
function CityPanel({ map, index, dispatch }: { map: MapV2; index: number; dispatch: Dispatch<EditorAction> }) {
  const city = map.cities[index]!;
  const [name, setName] = useState(city.name);
  const [level, setLevel] = useState(String(city.level));
  const [region, setRegion] = useState(String(city.region));
  useEffect(() => {
    setName(city.name);
    setLevel(String(city.level));
    setRegion(String(city.region));
  }, [city.name, city.level, city.region]);
  const save = () => {
    const patch: { name?: string; level?: number; region?: number } = { name: name.trim() };
    const lv = Number(level);
    const rg = Number(region);
    if (level.trim() !== '' && Number.isFinite(lv)) patch.level = lv;
    if (region.trim() !== '' && Number.isFinite(rg)) patch.region = rg;
    dispatch({ type: 'updateCity', index, patch });
  };
  const linked = map.cities.map((other, i) => ({ other, i })).filter(({ i }) => i !== index && isLinked(map, index, i));
  return (
    <div
      className={styles.form}
      role="group"
      aria-label={`도시 ${city.name}`}
      data-testid="city-panel"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) save();
      }}
    >
      <p className={styles.muted}>
        도시 ID {city.id} · 좌표 ({city.position.x}, {city.position.y})
      </p>
      <label className={styles.field}>
        이름
        <input value={name} onChange={(event) => setName(event.target.value)} onBlur={save} />
      </label>
      <label className={styles.field}>
        규모 ({LEVEL_RANGE.min}~{LEVEL_RANGE.max})
        <input type="number" value={level} onChange={(event) => setLevel(event.target.value)} onBlur={save} />
      </label>
      <label className={styles.field}>
        지역 ({REGION_RANGE.min}~{REGION_RANGE.max})
        <input type="number" value={region} onChange={(event) => setRegion(event.target.value)} onBlur={save} />
      </label>
      <h3>연결 {linked.length}개</h3>
      <ul className={styles.links}>
        {linked.map(({ other, i }) => (
          <li key={i}>
            {other.name}
            <button type="button" onClick={() => dispatch({ type: 'toggleLink', a: index, b: i })}>
              {other.name} 연결 끊기
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.danger} onClick={() => dispatch({ type: 'deleteCity', index })}>
        도시 삭제
      </button>
    </div>
  );
}

function TerrainPanel({
  map,
  layer,
  index,
  point,
  dispatch,
}: {
  map: MapV2;
  layer: TerrainLayer;
  index: number;
  point: number | null;
  dispatch: Dispatch<EditorAction>;
}) {
  const points = linePoints(map.terrain, layer, index) ?? [];
  const river = layer === 'rivers' ? map.terrain.rivers[index] : undefined;
  const [name, setName] = useState(river?.name ?? '');
  useEffect(() => setName(river?.name ?? ''), [river?.name]);
  const polygon = layer !== 'rivers';
  const closed = polygon && isClosedPolygon(points);
  const count = closed ? points.length - 1 : points.length;
  return (
    <div className={styles.form} data-testid="terrain-panel">
      <p>
        {layerLabel(layer)} {index + 1} · 점 <span className="num">{count}</span>개
        {polygon ? (closed ? ' · 닫힌 다각형' : ' · 열린 다각형') : ''}
      </p>
      {river ? (
        <label className={styles.field}>
          강 이름
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => dispatch({ type: 'renameRiver', index, name })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') dispatch({ type: 'renameRiver', index, name });
            }}
          />
        </label>
      ) : null}
      {polygon && !closed ? (
        <button type="button" onClick={() => dispatch({ type: 'closeTerrain', layer, index })}>
          다각형 닫기
        </button>
      ) : null}
      {point !== null ? (
        <button type="button" onClick={() => dispatch({ type: 'deleteTerrainPoint', layer, index, point })}>
          고른 점 지우기 ({point + 1}번째)
        </button>
      ) : (
        <DisabledReason reason="캔버스에서 네모 점을 눌러 고르세요">고른 점 지우기</DisabledReason>
      )}
      <button type="button" className={styles.danger} onClick={() => dispatch({ type: 'deleteTerrain', layer, index })}>
        선 지우기
      </button>
    </div>
  );
}

function IssueList({ issues, map, dispatch }: { issues: Issue[]; map: MapV2; dispatch: Dispatch<EditorAction> }) {
  return (
    <section className={styles.panel} aria-labelledby="issues-title" data-testid="issues">
      <h2 id="issues-title">
        검증 <span className="num">{issues.length}</span>건
      </h2>
      {issues.length === 0 ? (
        <p className={styles.ok}>C-M3 지도 항목을 모두 통과했습니다.</p>
      ) : (
        <ul className={styles.issues}>
          {issues.map((issue, i) => (
            <li key={i}>
              <button
                type="button"
                data-code={issue.code}
                onClick={() =>
                  dispatch({
                    type: 'select',
                    selection:
                      issue.target.kind === 'city'
                        ? { kind: 'city', index: issue.target.index }
                        : { kind: 'terrain', layer: issue.target.layer, index: issue.target.index, point: null },
                  })
                }
              >
                <span className={styles.issueTag}>오류</span> {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.muted}>
        밑그림은 {map.canvas.width * SKETCH_SCALE}×{map.canvas.height * SKETCH_SCALE} 팔레트 PNG입니다. 도시 점과 이름은
        넣지 않습니다.
      </p>
    </section>
  );
}
