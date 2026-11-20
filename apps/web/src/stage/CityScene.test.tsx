// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kitVariables } from '../ui/kit';
import { CastleWindow, INSIDE_BUILDINGS, insideBlock } from './CastleWindow';
import { CITY_LAND as SHARED_LAND, cityLandSlots } from '@opensamguk/shared';
import type { TurnDraftState } from '../turns/useTurnDraft';
import {
  CampScene,
  CITY_LAND,
  CityScene,
  asSiteKind,
  castleSprite,
  cityGrade,
  landCells,
  type CityLand,
  type LandBuilding,
} from './CityScene';
import { LotWindow, reserveInDraft } from './LotWindow';

afterEach(cleanup);

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('image')].map((node) => node.getAttribute('href') ?? '');

describe('성 화면 (D-106)', () => {
  it('거점 종류와 규모로 경, 특, 대, 중, 소, 현과 성 없는 거점을 고른다', () => {
    expect(cityGrade('CITY', 9)).toBe('경');
    expect(cityGrade('CITY', 8)).toBe('특');
    expect(cityGrade('CITY', 7)).toBe('대');
    expect(cityGrade('CITY', 6)).toBe('중');
    expect(cityGrade('CITY', 5)).toBe('소');
    expect(cityGrade('CITY', 2)).toBe('현');
    expect(cityGrade('PASS', 5)).toBe('현');
    expect(cityGrade('FIELD', 5)).toBeNull();
    expect(asSiteKind('BOGUS')).toBe('CITY');
  });

  it('등급이 높을수록 성 안 자리와 성 밖 땅이 많다', () => {
    const grades = ['경', '특', '대', '중', '소', '현'] as const;
    const outside = grades.map((grade) => {
      const { core, ring } = CITY_LAND[grade];
      return landCells(core + 2 * ring, core).length;
    });
    expect(outside).toEqual([128, 112, 72, 60, 32, 8]);
    expect(grades.map((grade) => CITY_LAND[grade].core ** 2)).toEqual([16, 9, 9, 4, 4, 1]);
  });

  it('거점 그림 고르기는 전체 지도와 같다', () => {
    expect(castleSprite('CITY', 9)).toMatch(/city\/scene\/castles\/city-9\.webp/);
    expect(castleSprite('CITY', 8)).toMatch(/castles\/capital\.webp/);
  });

  it('슬롯 방식 전경: 서버 땅 슬롯 수만큼 받침을 놓고 성벽 안을 누르면 성 안 창을 연다', () => {
    const open = vi.fn();
    render(<CityScene cityName="낙양" kind="CITY" level={9} onOpenCastle={open} />);
    const scene = screen.getByRole('group', { name: /낙양 성 화면: 경 등급, 성 안 자리 16칸, 성 밖 땅 128칸/ });
    expect(scene.getAttribute('data-slots')).toBe('144');
    expect(scene.getAttribute('data-gates')).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: '낙양성 안 보기' }));
    fireEvent.keyDown(screen.getByRole('button', { name: '낙양성 안 보기' }), { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('성 없는 거점은 성벽 없이 땅만 있다', () => {
    render(<CityScene cityName="관도" kind="FIELD" level={1} />);
    expect(screen.queryByRole('button', { name: /성 안 보기/ })).toBeNull();
    const scene = screen.getByTestId('city-scene');
    expect(scene.getAttribute('data-grade')).toBe('open');
    expect(scene.getAttribute('data-slots')).toBe('25');
    expect(scene.getAttribute('data-gates')).toBe('0');
  });

  it('진영 화면은 들판, 진영, 병종의 8방향 그림을 그린다', () => {
    const { container } = render(<CampScene placeName="영천" crewType={1100} />);
    expect(hrefs(container).some((href) => href.includes('battle/objects/camp'))).toBe(true);
    expect(hrefs(container).some((href) => href.includes('battle/units8/1100'))).toBe(true);
  });
});

describe('성 안 창', () => {
  it('성 안 건물 16종을 보이고 조건이 안 맞는 건물은 이유를 단다', () => {
    expect(INSIDE_BUILDINGS).toHaveLength(16);
    const grand = INSIDE_BUILDINGS.find((building) => building.name === '대시장')!;
    expect(insideBlock(grand, '소', '낙양')).toBe('대 이상');
    expect(insideBlock(grand, '대', '낙양')).toBeNull();
    const close = vi.fn();
    render(<CastleWindow cityName="낙양" grade="소" onClose={close} />);
    expect(screen.getByRole('heading', { name: '낙양성 안 (소)' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '성 안 자리 4칸, 모두 빈 터' })).toBeTruthy();
    const list = screen.getByRole('list', { name: '성 안에 지을 수 있는 건물' });
    expect(list.querySelectorAll('li')).toHaveLength(16);
    expect(screen.getByText('업 한정')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(close).toHaveBeenCalled();
  });
});

// 소 등급(성 안 4칸, 성 밖 32칸) 건설 정보. 서버 cityLandInfo와 같은 모양이다.
function smallLand(rows: LandBuilding[] = []): CityLand {
  const slots = cityLandSlots('CITY', 5);
  const specs = [
    { key: 'market', name: '시장', zone: 'inside' as const, gold: 100, wood: 10, turns: 1, unique: false },
    { key: 'grand_market', name: '대시장', zone: 'inside' as const, gold: 300, wood: 30, turns: 2, unique: true },
    { key: 'farm', name: '농지', zone: 'outside' as const, gold: 100, wood: 10, turns: 1, unique: false },
    { key: 'citadel', name: '성채', zone: 'outside' as const, gold: 100, wood: 10, turns: 2, unique: false },
    { key: 'saltworks', name: '염전', zone: 'outside' as const, gold: 100, wood: 10, turns: 1, unique: false },
  ];
  const blocked: Record<string, string> = {
    grand_market: '대 이상 성에만 지을 수 있습니다.',
    saltworks: '바닷가가 아닙니다.',
  };
  return {
    cityKey: 3,
    grade: '소',
    core: 2,
    slots: slots.map((slot) => ({ ...slot, building: rows.find((row) => row.slotId === slot.id) ?? null })),
    buildings: specs.map((spec) => ({
      ...spec,
      slots: slots
        .filter((slot) => slot.zone === spec.zone)
        .map((slot) => ({
          slotId: slot.id,
          failure: blocked[spec.key] ? { code: 'BLOCKED', message: blocked[spec.key]! } : null,
        })),
    })),
  };
}

describe('성 건설 정보 (D-107)', () => {
  it('등급표는 서버 규칙과 같은 공유 정본이다', () => {
    expect(CITY_LAND).toBe(SHARED_LAND);
  });

  it('성 밖에 지은 건물과 공사 중인 건물의 남은 달 수를 그린다', () => {
    const land = smallLand([
      { slotId: '-1.5,-1.5', building: 'farm', remainingTurns: 0, score: 50 },
      { slotId: '1.5,1.5', building: 'citadel', remainingTurns: 2, score: 0 },
      { slotId: '-0.5,-0.5', building: 'market', remainingTurns: 0, score: 50 },
    ]);
    const lot = vi.fn();
    const { container } = render(<CityScene cityName="복양" kind="CITY" level={5} land={land} onLot={lot} />);
    const built = [...container.querySelectorAll('[data-testid="lot-building"]')];
    // 성 안 시장은 성 밖 그림에 없다.
    expect(built.map((node) => node.getAttribute('data-building'))).toEqual(['farm', 'citadel']);
    const citadel = built.find((node) => node.getAttribute('data-building') === 'citadel')!;
    expect(citadel.getAttribute('opacity')).toBe('0.55');
    expect(citadel.querySelector('[data-testid="lot-remaining"]')?.textContent).toBe('2');
    // 슬롯 그림이 있는 건물(농지)은 캔버스에 그림으로 그리고 표식 아이콘, 이름표를 겹치지 않는다.
    expect(built[0]!.querySelector('image')).toBeNull();
    expect(built[0]!.textContent).not.toContain('농지');
    expect(container.querySelector('[data-testid="city-scene"]')!.getAttribute('data-style')).toBe('central');
    expect(screen.getByText('복양 (소, 빈 터 30)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '성 밖 1.5,1.5 성채' }));
    expect(lot).toHaveBeenCalledWith('1.5,1.5');
    expect(container.querySelectorAll('[data-testid="city-lots"] [role="button"]')).toHaveLength(32);
  });

  it('빈 터 창은 성 밖 건물의 비용과 기간, 막힌 이유를 보이고 고른 건설을 넣는다', () => {
    const reserve = vi.fn(() => ({ ok: true as const, slot: 2 }));
    render(<LotWindow land={smallLand()} slotId="-1.5,-1.5" onReserve={reserve} onClose={() => {}} />);
    const list = screen.getByRole('list', { name: '성 밖에 지을 수 있는 건물' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('바닷가가 아닙니다.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /염전/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('금 100, 목재 10, 2달')).toHaveLength(1);
    const put = screen.getByRole('button', { name: '예턴에 넣기' }) as HTMLButtonElement;
    expect(put.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /농지/ }));
    fireEvent.click(put);
    expect(reserve).toHaveBeenCalledWith({ commandKey: 'build', args: { slotId: '-1.5,-1.5', building: 'farm' } });
    expect(screen.getByRole('status').textContent).toContain('예턴 3번 칸에 넣었습니다');
  });

  it('지은 자리 창은 건물 이름과 철거를 보인다', () => {
    const reserve = vi.fn(() => ({ ok: false as const, message: '예턴에 빈 칸이 없습니다.' }));
    const land = smallLand([{ slotId: '1.5,1.5', building: 'citadel', remainingTurns: 1, score: 0 }]);
    render(<LotWindow land={land} slotId="1.5,1.5" onReserve={reserve} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: '성 밖 성채' })).toBeTruthy();
    expect(screen.getByText('공사 중, 1달 남음')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '철거 예턴에 넣기' }));
    expect(reserve).toHaveBeenCalledWith({ commandKey: 'demolish', args: { slotId: '1.5,1.5' } });
    expect(screen.getByRole('status').textContent).toBe('예턴에 빈 칸이 없습니다.');
  });

  it('예턴에 넣을 연결이 없으면 넣기 단추를 막는다', () => {
    render(<LotWindow land={smallLand()} slotId="-1.5,-1.5" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /농지/ }));
    expect((screen.getByRole('button', { name: '예턴에 넣기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('초안의 첫 빈 칸에 직접 넣은 칸으로 넣고 저장은 하지 않는다', () => {
    const rest = { commandKey: 'rest', args: {}, explicit: false };
    const edit = vi.fn();
    const editAndSave = vi.fn();
    const draft = {
      turns: [{ commandKey: 'train', args: {}, explicit: true }, rest, rest],
      pending: null,
      saving: false,
      edit,
      editAndSave,
    } as unknown as TurnDraftState;
    expect(reserveInDraft(draft, { commandKey: 'demolish', args: { slotId: '0,1' } })).toEqual({ ok: true, slot: 1 });
    expect(edit).toHaveBeenCalledWith({
      put: { indices: [1], turn: { commandKey: 'demolish', args: { slotId: '0,1' }, explicit: true } },
    });
    expect(editAndSave).not.toHaveBeenCalled();
    expect(reserveInDraft(null, { commandKey: 'demolish', args: { slotId: '0,1' } }).ok).toBe(false);
    const full = { ...draft, turns: [{ commandKey: 'train', args: {}, explicit: true }] } as unknown as TurnDraftState;
    expect(reserveInDraft(full, { commandKey: 'demolish', args: { slotId: '0,1' } })).toEqual({
      ok: false,
      message: '예턴에 빈 칸이 없습니다.',
    });
  });

  it('성 안 창은 서버 자리와 지은 건물, 자리별 막힌 이유를 쓴다', () => {
    const land = smallLand([{ slotId: '-0.5,-0.5', building: 'market', remainingTurns: 0, score: 50 }]);
    const reserve = vi.fn(() => ({ ok: true as const, slot: 0 }));
    const { container } = render(
      <CastleWindow cityName="복양" grade="소" land={land} onReserve={reserve} onClose={() => {}} />,
    );
    expect(screen.getByRole('group', { name: '성 안 자리 4칸, 빈 터 3칸' })).toBeTruthy();
    expect(container.querySelector('[data-slot="-0.5,-0.5"]')?.getAttribute('data-building')).toBe('market');
    expect(hrefs(container).some((href) => href.includes('facilities/icons/market'))).toBe(true);
    // 처음에는 첫 빈 자리를 고른다.
    expect(screen.getByRole('button', { name: '성 안 -0.5,0.5 빈 터' }).getAttribute('aria-pressed')).toBe('true');
    const list = screen.getByRole('list', { name: '성 안에 지을 수 있는 건물' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('대 이상 성에만 지을 수 있습니다.')).toBeTruthy();
    expect(screen.getByText('금 300, 목재 30, 2달')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^시장/ }));
    fireEvent.click(screen.getByRole('button', { name: '예턴에 넣기' }));
    expect(reserve).toHaveBeenCalledWith({ commandKey: 'build', args: { slotId: '-0.5,0.5', building: 'market' } });
    // 지은 자리를 고르면 철거를 보인다.
    fireEvent.click(screen.getByRole('button', { name: '성 안 -0.5,-0.5 시장' }));
    expect(screen.getByRole('button', { name: '철거 예턴에 넣기' })).toBeTruthy();
  });
});

describe('UI 키트 변수', () => {
  it('승인 목록에 있는 키트 그림을 CSS 변수로 만든다', () => {
    const vars = kitVariables();
    expect(vars['--kit-frame-window']).toMatch(/^url\(".*ui\/kit-a\/frame-window\.webp"\)$/);
    expect(vars['--kit-button-primary-1']).toMatch(/states\/button-primary-1\.webp/);
    expect(vars['--kit-table-row-2']).toMatch(/states\/table-row-2\.webp/);
  });
});
