// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { moveReach } from './BattleBoard';
import { routeNote, routePaths } from './council';
import { demoBattle, demoSiege } from './demoBattle';
import { TacticalBattleView } from './TacticalBattleView';

afterEach(cleanup);

describe('작전 회의', () => {
  it('진로를 고르면 효과 줄과 편성 칸의 작전 이름이 바뀐다', () => {
    const onRoute = vi.fn();
    render(
      <TacticalBattleView
        battle={{ ...demoBattle, phase: 'council', route: null }}
        mySide="attack"
        onRoute={onRoute}
      />,
    );
    expect(screen.getByText(routeNote('front'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '포위' }));
    expect(onRoute).toHaveBeenCalledWith('encircle');
    expect(screen.getByText('달성하면 사기 변동 ±80. 유효 기간 25턴.')).toBeTruthy();
    expect(screen.getByRole('group', { name: '진로' })).toBeTruthy();
  });

  it('수비측은 요격·기습·농성을 고른다', () => {
    const onDefense = vi.fn();
    render(<TacticalBattleView battle={{ ...demoBattle, phase: 'council' }} mySide="defend" onDefense={onDefense} />);
    fireEvent.click(screen.getByRole('button', { name: '농성' }));
    expect(onDefense).toHaveBeenCalledWith('hold');
  });

  it('포위는 화살표 셋, 나머지 진로는 하나다', () => {
    expect(routePaths('encircle', 12, 12)).toHaveLength(3);
    expect(routePaths('left', 12, 12)).toHaveLength(1);
  });
});

describe('야전 다시보기', () => {
  it('턴을 넘기면 턴 표시와 공·수 비교가 바뀐다', () => {
    render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    expect(screen.getByText('6 / 30턴')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '처음' }));
    expect(screen.getByText('0 / 30턴')).toBeTruthy();
    expect(screen.getByRole('status', { name: '전투 소식' }).textContent).toContain('전투가 시작되었습니다.');
    fireEvent.click(screen.getByRole('button', { name: '다음 턴' }));
    expect(screen.getByText('1 / 30턴')).toBeTruthy();
  });

  it('교전 결과 상자에 공·수 병사 변화를 보인다', () => {
    render(<TacticalBattleView battle={{ ...demoBattle, frames: demoBattle.frames.slice(0, 6) }} mySide="attack" />);
    expect(screen.getByRole('status', { name: '전투 소식' }).textContent).toContain('2,350 → 2,209');
  });

  it('직접 지휘 중에는 내 부대의 이동 범위 안 칸을 눌러 이동을 지시한다', () => {
    const onMove = vi.fn();
    const live = { ...demoBattle, frames: demoBattle.frames.slice(0, 1), liveUntil: '2026-11-15T12:00:00.000Z' };
    const { container } = render(
      <TacticalBattleView battle={live} mySide="attack" myGeneralIds={[1]} onMove={onMove} />,
    );
    expect(screen.getByText(/직접 지휘 중입니다/)).toBeTruthy();
    const commander = live.frames[0]!.units.find((unit) => unit.id === 1)!;
    const reach = moveReach(live.board, live.frames[0]!.units, commander, 4);
    expect(reach.size).toBeGreaterThan(0);
    // 칸은 깊이 순으로 그리므로 칸 제목의 좌표로 찾는다.
    const tile = (x: number, y: number) =>
      [...container.querySelectorAll('polygon[class*="tile"]')].find((el) =>
        el.querySelector('title')?.textContent?.endsWith(`(${x}, ${y})`),
      )!;
    fireEvent.click(tile(commander.x, commander.y));
    const [target] = [...reach];
    const [tx, ty] = target!.split(',').map(Number);
    fireEvent.click(tile(tx!, ty!));
    expect(onMove).toHaveBeenCalledWith(1, tx, ty);
  });

  it('고른 부대도 직접 지휘도 없으면 오른쪽 판을 비운다', () => {
    render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    expect(screen.queryByRole('complementary', { name: '고른 부대' })).toBeNull();
  });
});

describe('야전 칸 규칙 (D-105)', () => {
  it('전황에 날씨와 바람을 보이고 날씨 덮개를 깐다', () => {
    const { container } = render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    const hud = within(screen.getByLabelText('전황'));
    expect(hud.getByText('비')).toBeTruthy();
    expect(hud.getByText(/북동쪽으로/)).toBeTruthy();
    expect(container.querySelector('[data-weather="rain"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '처음' }));
    expect(hud.getByText('맑음')).toBeTruthy();
    expect(container.querySelector('[data-weather]')).toBeNull();
  });

  it('보이는 칸 밖은 가리고, 보이는 불만 그린다', () => {
    const { container } = render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    const frame = demoBattle.frames.at(-1)!;
    const cells = demoBattle.board.width * demoBattle.board.height;
    expect(container.querySelectorAll('g[data-fog="true"]').length).toBe(cells - frame.visibleCells!.length);
    expect(frame.burningCells!.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-burning="true"]').length).toBe(frame.burningCells!.length);
  });

  it('지물(다리, 흙더미, 무너진 터, 마을)과 거점 지물을 세운다', () => {
    const { container } = render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    for (const kind of ['bridge', 'earthwork', 'rubble', 'village', 'fort-medium', 'camp', 'supply'])
      expect(container.querySelector(`image[data-kind="${kind}"]`), kind).toBeTruthy();
    expect(container.querySelector('image[data-kind="bridge"]')!.getAttribute('href')).toContain('bridge-ne');
  });

  it('부대 정보에 시야와 화상 부상을 보인다', () => {
    const { container } = render(<TacticalBattleView battle={demoBattle} mySide="attack" />);
    const guan = demoBattle.frames.at(-1)!.units.find((entry) => entry.id === 2)!;
    const tile = [...container.querySelectorAll('polygon[class*="tile"]')].find((el) =>
      el.querySelector('title')?.textContent?.endsWith(`(${guan.x}, ${guan.y})`),
    )!;
    fireEvent.click(tile);
    const side = within(screen.getByRole('complementary', { name: '고른 부대' }));
    expect(side.getByText('3칸')).toBeTruthy();
    expect(side.getByText('화상 부상')).toBeTruthy();
  });

  it('옛 프레임(시야 목록 없음)은 가리지 않는다', () => {
    const old = {
      ...demoBattle,
      frames: demoBattle.frames.map((frame) => {
        const copy = { ...frame };
        delete copy.visibleCells;
        delete copy.burningCells;
        delete copy.environment;
        return copy;
      }),
    };
    const { container } = render(<TacticalBattleView battle={old} mySide="attack" />);
    expect(container.querySelector('[data-fog="true"]')).toBeNull();
    expect(container.querySelector('[data-weather]')).toBeNull();
  });
});

describe('공성전', () => {
  it('방어도와 성벽 손상 단계를 보인다', () => {
    render(<TacticalBattleView battle={demoSiege()} mySide="attack" />);
    expect(within(screen.getByLabelText('전황')).getByText('524')).toBeTruthy();
    expect(screen.getByRole('img', { name: /성벽 손상 \d단계/ })).toBeTruthy();
    expect(screen.getByRole('status', { name: '전투 소식' }).textContent).toContain('곽준');
  });
});
