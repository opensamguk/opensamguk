import { describe, expect, it } from 'vitest';
import { CITY_LAND, cityLandSlots, type CityGrade } from '@opensamguk/shared';
import {
  PALACE_BAND,
  WALL_GRADE,
  WALL_SIZE,
  castleLayout,
  depthOrder,
  pathMerlons,
  slotAt,
  thickFits,
  wallBoxes,
  wallChunks,
} from './castleGeometry';

const LEVEL: Record<CityGrade, number> = { 경: 9, 특: 8, 대: 7, 중: 6, 소: 5, 현: 2 };
const GRADES = ['현', '소', '중', '대', '특', '경'] as const;
const layoutOf = (grade: CityGrade) => castleLayout(grade, cityLandSlots('CITY', LEVEL[grade]));

describe('슬롯 방식 성 기하 (기획 4.1, 4.3)', () => {
  it('서버 슬롯 하나가 3×3칸 받침 하나이고, 받침끼리 겹치지 않으며 성벽 칸과도 겹치지 않는다', () => {
    for (const grade of GRADES) {
      const layout = layoutOf(grade);
      const { core, ring } = CITY_LAND[grade];
      expect(layout.slots).toHaveLength((core + 2 * ring) ** 2);
      // 성 안 맨 뒤 줄과 열은 태수부 띠(슬롯 한 칸 너비)라 성 안 한 변이 슬롯 하나만큼 넓다.
      expect(layout.inner).toBe(1 + 4 * (core + PALACE_BAND));
      // 태수부 받침(맨 뒤 모서리 3 x 3칸)은 성 안이고 어느 슬롯과도 겹치지 않는다.
      expect(layout.palace).toEqual({ a: 1, b: 1 });
      for (let i = 1; i < 4; i++) for (let j = 1; j < 4; j++) expect(slotAt(layout, i, j)).toBeNull();
      const seen = new Set<string>();
      for (const s of layout.slots)
        for (let i = s.a; i < s.a + 3; i++)
          for (let j = s.b; j < s.b + 3; j++) {
            const key = `${i},${j}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            const onWall = i === -1 || i === layout.inner || j === -1 || j === layout.inner;
            const inRing = i >= -1 && i <= layout.inner && j >= -1 && j <= layout.inner;
            expect(onWall && inRing).toBe(false);
          }
      // 성 안 슬롯은 성벽 안, 성 밖 슬롯은 성벽 밖.
      for (const s of layout.slots) {
        const inside = s.a >= 0 && s.a + 3 <= layout.inner && s.b >= 0 && s.b + 3 <= layout.inner;
        expect(inside).toBe(s.zone === 'inside');
      }
    }
  });

  it('슬롯 사이와 성벽 둘레는 1칸 길이다', () => {
    const layout = layoutOf('소');
    // 성벽 바로 안쪽 칸과 바로 바깥쪽 칸은 늘 길.
    for (let k = 0; k < layout.inner; k++) {
      expect(slotAt(layout, 0, k)).toBeNull();
      expect(slotAt(layout, layout.inner - 1, k)).toBeNull();
      expect(slotAt(layout, -2, k)).toBeNull();
      expect(slotAt(layout, layout.inner + 1, k)).toBeNull();
    }
    expect(slotAt(layout, 1, 1)).toBeNull(); // 태수부 자리
    expect(slotAt(layout, 5, 5)?.zone).toBe('inside');
  });

  it('성벽 단계, 성문 수, 치는 등급을 따른다', () => {
    expect(GRADES.map((g) => WALL_GRADE[g].level)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(GRADES.map((g) => layoutOf(g).gateSides.length)).toEqual([1, 1, 2, 2, 4, 4]);
    // 성문은 늘 벽 가운데.
    for (const g of GRADES) expect(layoutOf(g).gate).toBe((layoutOf(g).inner - 1) / 2);
  });

  it('높이는 성벽 단계를 따르고, 두께는 성가퀴 간격과 맞는 값이다', () => {
    // 칠한 성벽 그림이 단계별 높이라 같은 단계 두 등급은 같은 높이, 단계가 오를수록 높다.
    const heights = GRADES.map((g) => WALL_SIZE[g].height);
    expect(heights).toEqual([56, 56, 76, 76, 96, 96]);
    for (const g of GRADES) expect(thickFits(WALL_SIZE[g].n, WALL_SIZE[g].thick)).toBe(true);
    expect(thickFits(4, 0.5)).toBe(false);
  });

  it('성가퀴는 한 가지 크기와 간격이고 칸 경계에는 걸리지 않는다', () => {
    const n = 4;
    // 칸 경계(정수)는 빈틈 한가운데이므로 0에서 출발한다.
    const boxes = pathMerlons(
      [
        [0, 0],
        [10, 0],
      ],
      0,
      10,
      n,
    );
    const widths = new Set(boxes.map((b) => +(b[1] - b[0]).toFixed(6)));
    expect(widths.size).toBe(1);
    for (const b of boxes) expect(Math.floor(b[0] + 1e-9)).toBe(Math.floor(b[1] - 1e-9));
  });

  it('바깥 모서리에는 성가퀴 네모가 하나 서고, 안쪽 꺾임은 빈틈이다', () => {
    // 치 하나가 달린 직선: 안쪽 꺾임(치가 벽에 붙는 자리) 둘, 바깥 꼭짓점 둘.
    const n = 4;
    const p = 1 / n;
    const E = 0.875;
    const F = E + 1.5 * p;
    const path: Array<[number, number]> = [
      [-1, E],
      [p, E],
      [p, F],
      [1 - p, F],
      [1 - p, E],
      [3, E],
    ];
    // 진행 방향 왼쪽이 몸통이 되도록 -i 방향으로 돈다(앞쪽 벽).
    const boxes = pathMerlons(path.slice().reverse(), 0, 10, n);
    const touches = (x: number, y: number) =>
      boxes.some((b) => b[0] <= x + 1e-9 && x <= b[1] + 1e-9 && b[2] <= y + 1e-9 && y <= b[3] + 1e-9);
    expect(touches(p, F)).toBe(true);
    expect(touches(1 - p, F)).toBe(true);
    expect(touches(p, E)).toBe(false);
    expect(touches(1 - p, E)).toBe(false);
  });

  it('그리는 순서에 고리가 없다(문루, 치, 꺾임 포함)', () => {
    for (const g of GRADES) {
      const layout = layoutOf(g);
      const chunks = wallChunks(layout);
      expect(chunks.length).toBeGreaterThan(0);
      expect(depthOrder(chunks).cycles).toBe(0);
    }
  });

  it('네 모서리에 각루가 서고, 모서리 칸에는 각루만 있다', () => {
    for (const g of GRADES) {
      const layout = layoutOf(g);
      const { lo, hi } = layout.wall!;
      const inCorner = wallChunks(layout).filter((ch) => {
        const a = Math.floor(ch.c[0] + 1e-6);
        const b = Math.floor(ch.c[2] + 1e-6);
        return (a === lo || a === hi) && (b === lo || b === hi);
      });
      expect(inCorner.length).toBeGreaterThan(0);
      // 모서리 칸에는 성벽 몸통이 없고 각루(돌 대, 성가퀴, 누각)만 있다.
      expect(inCorner.some((ch) => ch.o[6] === 'wall')).toBe(false);
      // 각루 대는 성벽보다 높다.
      const top = Math.max(...inCorner.map((ch) => ch.c[5]));
      expect(top).toBeGreaterThan(WALL_SIZE[g].height + WALL_SIZE[g].merlon);
    }
  });

  it('성이 없는 거점은 성벽이 없다', () => {
    const layout = castleLayout(null, cityLandSlots('FIELD', 1));
    expect(layout.wall).toBeNull();
    expect(wallBoxes(layout)).toEqual([]);
    expect(layout.slots).toHaveLength(25);
  });
});
