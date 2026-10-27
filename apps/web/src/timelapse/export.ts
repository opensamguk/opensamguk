import { MAP_HEIGHT, MAP_WIDTH, mapLinks } from '../main/WorldMap';
import type { FrameView, LegendEntry, TimelapseFrame } from './frames';

// 지금 달 PNG의 그리기 명령 (docs/plans/T4-37.md 2.2). 순수 함수라 캔버스 없이 시험한다.
// 입력은 재생 화면과 같은 frameView 결과뿐이다. 저장된 국가 이름·색과 공백지 색 밖의 값은 들어오지 않는다.

export type DrawOp =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; stroke?: string }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string }
  | { kind: 'circle'; x: number; y: number; r: number; fill: string | null; stroke: string; dashed: boolean }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
      align: 'left' | 'right';
      weight: 400 | 600;
      maxWidth?: number;
    };

export interface PngDrawing {
  width: number;
  height: number;
  ops: readonly DrawOp[];
}

// 그림 크기(CSS 픽셀). 캔버스는 EXPORT_SCALE배로 만든다. 지도 좌표는 화면 지도(WorldMap.tsx)와 같다.
export const EXPORT_SCALE = 2;
export const HEADER_HEIGHT = 40;
const LEGEND_COLUMNS = 4;
const LEGEND_ROWS = 4;
const LEGEND_ROW_HEIGHT = 20;
const LEGEND_HEIGHT = 12 + LEGEND_ROWS * LEGEND_ROW_HEIGHT;
const FOOTER_HEIGHT = 24;
export const EXPORT_WIDTH = MAP_WIDTH;
export const EXPORT_HEIGHT = HEADER_HEIGHT + MAP_HEIGHT + LEGEND_HEIGHT + FOOTER_HEIGHT;
// 공백지 색. 재생 화면과 메인 지도의 값과 같다.
export const NEUTRAL = '#d6d0c4';
export const DOT_R = 6;
const COLORS = {
  background: '#ffffff',
  ground: '#f1ede4',
  link: '#9a9488',
  dotStroke: '#6b665c',
  text: '#222222',
  muted: '#5c5850',
} as const;
export const EXPORT_NOTE = '국가 이름과 색은 그 달에 기록된 값입니다. 오픈삼국';

type DrawnView = Extract<FrameView, { kind: 'ok' }>;

// 모든 국가를 재생 화면 순서로 놓고 공백지 칸을 마지막에 둔다.
function legendCells(legend: readonly LegendEntry[], empty: number) {
  const cells: Array<{ text: string; color: string }> = [];
  for (const { nation, count } of legend) cells.push({ text: `${nation.name} ${count}`, color: nation.color });
  cells.push({ text: `공백지 ${empty}`, color: NEUTRAL });
  return cells;
}

export function frameDrawing(input: {
  worldName: string;
  date: string;
  view: DrawnView;
  canvas?: { width: number; height: number };
}): PngDrawing {
  const { worldName, date, view } = input;
  const mapWidth = input.canvas?.width ?? MAP_WIDTH;
  const mapHeight = input.canvas?.height ?? MAP_HEIGHT;
  const exportWidth = mapWidth;
  const legendTop = HEADER_HEIGHT + mapHeight + 12;
  const cells = legendCells(view.legend, view.empty);
  const extraRows = Math.max(0, Math.ceil(cells.length / LEGEND_COLUMNS) - LEGEND_ROWS);
  const height = HEADER_HEIGHT + mapHeight + LEGEND_HEIGHT + FOOTER_HEIGHT + extraRows * LEGEND_ROW_HEIGHT;
  const ops: DrawOp[] = [
    { kind: 'rect', x: 0, y: 0, w: exportWidth, h: height, fill: COLORS.background },
    {
      kind: 'text',
      x: 12,
      y: 26,
      text: `${worldName} · ${date}`,
      size: 16,
      color: COLORS.text,
      align: 'left',
      weight: 600,
      maxWidth: exportWidth - 24,
    },
    { kind: 'rect', x: 0, y: HEADER_HEIGHT, w: mapWidth, h: mapHeight, fill: COLORS.ground },
  ];
  for (const [a, b] of mapLinks(view.cities.map(({ city }) => city))) {
    ops.push({
      kind: 'line',
      x1: a.x,
      y1: a.y + HEADER_HEIGHT,
      x2: b.x,
      y2: b.y + HEADER_HEIGHT,
      stroke: COLORS.link,
    });
  }
  for (const { city, nation } of view.cities) {
    const y = city.y + HEADER_HEIGHT;
    // 프레임에 없는 지도 도시는 화면처럼 점선 빈 원이다.
    if (nation === null) {
      ops.push({ kind: 'circle', x: city.x, y, r: DOT_R, fill: null, stroke: COLORS.dotStroke, dashed: true });
      continue;
    }
    const fill = nation.kind === 'stored' ? nation.color : NEUTRAL;
    ops.push({ kind: 'circle', x: city.x, y, r: DOT_R, fill, stroke: COLORS.dotStroke, dashed: false });
  }
  const cellWidth = exportWidth / LEGEND_COLUMNS;
  cells.forEach((cell, i) => {
    const x = (i % LEGEND_COLUMNS) * cellWidth + 12;
    const y = legendTop + Math.floor(i / LEGEND_COLUMNS) * LEGEND_ROW_HEIGHT;
    ops.push({ kind: 'rect', x, y, w: 10, h: 10, fill: cell.color, stroke: COLORS.dotStroke });
    ops.push({
      kind: 'text',
      x: x + 16,
      y: y + 10,
      text: cell.text,
      size: 12,
      color: COLORS.text,
      align: 'left',
      weight: 400,
      maxWidth: cellWidth - 32,
    });
  });
  ops.push({
    kind: 'text',
    x: exportWidth - 12,
    y: height - 8,
    text: EXPORT_NOTE,
    size: 11,
    color: COLORS.muted,
    align: 'right',
    weight: 400,
    maxWidth: exportWidth - 24,
  });
  return { width: exportWidth, height, ops };
}

// 파일 이름에 쓸 수 없는 글자(경로 구분자, 예약 문자, 제어 문자)는 밑줄로 바꾼다. 비거나 점뿐이면 월드로 둔다.
const RESERVED = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
const unsafe = (char: string) => RESERVED.has(char) || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
export function safeFileName(name: string): string {
  const cleaned = Array.from(name, (char) => (unsafe(char) ? '_' : char))
    .join('')
    .trim();
  return cleaned === '' || /^\.+$/.test(cleaned) ? '월드' : cleaned;
}

export function pngFileName(worldName: string, frame: Pick<TimelapseFrame, 'year' | 'month'>): string {
  return `opensamguk-${safeFileName(worldName)}-${frame.year}-${frame.month}.png`;
}
