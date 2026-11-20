import { describe, expect, it } from 'vitest';
import { screenFacing, tileCenter, unitFrame } from './BattleBoard';

// 전술 전투는 이웃 8칸으로 움직이고, 마름모로 눕힌 칸에서 그 8칸이 화면 8방향이 된다(사용자 2026-11-15 "8방향").
describe('부대 그림 방향', () => {
  const height = 10;
  const dir = (dx: number, dy: number) => {
    const [ax, ay] = tileCenter(5, 5, height);
    const [bx, by] = tileCenter(5 + dx, 5 + dy, height);
    return screenFacing(bx - ax, by - ay);
  };

  it('이웃 8칸이 화면 8방향으로 나뉜다', () => {
    expect(dir(1, 1)).toBe(0); // 아래
    expect(dir(1, 0)).toBe(1); // 오른쪽 아래
    expect(dir(1, -1)).toBe(2); // 오른쪽
    expect(dir(0, -1)).toBe(3); // 오른쪽 위
    expect(dir(-1, -1)).toBe(4); // 위
    expect(dir(-1, 0)).toBe(5); // 왼쪽 위
    expect(dir(-1, 1)).toBe(6); // 왼쪽
    expect(dir(0, 1)).toBe(7); // 왼쪽 아래
  });

  it('8방향 판은 오른쪽 다섯 칸을 쓰고 왼쪽은 뒤집는다', () => {
    const art = { url: 'x', eight: true };
    expect(unitFrame(art, 0, false)).toMatchObject({ col: 0, row: 0, flip: false });
    expect(unitFrame(art, 2, true)).toMatchObject({ col: 2, row: 1, flip: false });
    expect(unitFrame(art, 4, false)).toMatchObject({ col: 4, flip: false });
    expect(unitFrame(art, 6, false)).toMatchObject({ col: 2, flip: true });
    expect(unitFrame(art, 7, true)).toMatchObject({ col: 1, row: 1, flip: true });
  });

  it('옛 판은 앞모습과 뒷모습 중 가까운 쪽을 쓴다', () => {
    const art = { url: 'x', eight: false };
    expect(unitFrame(art, 1, false)).toMatchObject({ col: 0, row: 0, flip: false });
    expect(unitFrame(art, 7, true)).toMatchObject({ col: 1, row: 0, flip: true });
    expect(unitFrame(art, 5, false)).toMatchObject({ col: 0, row: 1, flip: false });
    expect(unitFrame(art, 3, false)).toMatchObject({ row: 1, flip: true });
  });
});
