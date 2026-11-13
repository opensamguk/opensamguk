// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CityView, GeneralView, MapCity, NationView, WorldMap as WorldMapResponse } from '../game/types';
import { cityRegionTitle, GeneralNameCell } from './CityInfo';
import { CityOffices, cityOfficeSeats } from './CityOffices';
import { MapGenerals } from './MapGenerals';
import { generalsByCity, generalsText, tooltipGenerals, type MapGeneral } from './mapGeneralList';
import { humanQuotaText } from './mainProgress';
import { NationFinanceGrid, NationSummaryGrid } from './NationInfo';
import { cityLabel, WorldMap } from './WorldMap';

// INT-26 서버 값(지도 장수·지역·관직·성향·주민·정산 예상·사람 장수 정원)을 화면에 쓰는지 본다.
// 얼굴은 변형·모양만 확인하려고 Portrait를 바꿔 끼운다.
vi.mock('../portrait/Portrait', () => ({
  Portrait: ({ name, variant, shape }: { name: string; variant?: string; shape?: string }) => (
    <span data-portrait={name} data-variant={variant} data-shape={shape} />
  ),
}));

afterEach(cleanup);

const general = (id: number, name: string, cityKey: number, isHuman: boolean): MapGeneral => ({
  id,
  name,
  cityKey,
  nationId: 1,
  portraitId: id,
  isHuman,
});

describe('지도 풍선 장수 목록', () => {
  const generals = [
    general(1, '조조(曹操)', 1, false),
    general(2, '순욱', 1, true),
    general(3, '하후돈', 2, false),
    general(4, '하후연', 1, false),
    general(5, '조인', 1, false),
    general(6, '조홍', 1, false),
    general(7, '악진', 1, false),
  ];

  it('거점별로 묶고 사람 장수를 앞에 두며 다섯 명 뒤는 외 N명으로 센다', () => {
    const byCity = generalsByCity(generals);
    expect(byCity.get(2)?.map((g) => g.id)).toEqual([3]);
    const { shown, rest } = tooltipGenerals(byCity.get(1)!);
    expect(shown.map((g) => g.id)).toEqual([2, 1, 4, 5, 6]);
    expect(rest).toBe(1);
    expect(generalsText(byCity.get(1)!)).toBe('장수 6명: 순욱, 조조 NPC, 하후연 NPC, 조인 NPC, 조홍 NPC 외 1명');
    expect(generalsText([])).toBeNull();
  });

  it('원형 icon 얼굴·괄호 뺀 이름·NPC 딱지를 쓴다', () => {
    render(<MapGenerals generals={[general(1, '조조(曹操)', 1, false), general(2, '순욱', 1, true)]} />);
    const list = screen.getByTestId('map-tooltip-generals');
    expect(list.textContent).toContain('장수 2명');
    const face = list.querySelector('[data-portrait="조조"]');
    expect(face?.getAttribute('data-variant')).toBe('icon');
    expect(face?.getAttribute('data-shape')).toBe('round');
    const rows = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['순욱', '조조NPC']);
  });

  it('장수가 없으면 줄을 그리지 않는다', () => {
    const { container } = render(<MapGenerals generals={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('고전 지도의 지역·장수', () => {
  const city = (key: number, extra: Partial<MapCity> = {}): MapCity => ({
    key,
    name: key === 1 ? '업' : '허창',
    level: 8,
    x: 100 * key,
    y: 100,
    nationId: 1,
    supplied: true,
    links: [],
    ...extra,
  });
  const nations = [{ id: 1, name: '위', color: '#202020' }];

  it('지역 이름을 받으면 읽기 이름에 넣는다', () => {
    expect(cityLabel(city(1, { region: 1, regionName: '하북' }), nations[0], false)).toBe('업, 하북, 위');
    expect(cityLabel(city(1), nations[0], false)).toBe('업, 위');
  });

  it('장수를 주면 SVG 제목에 장수 이름을 더하고 마우스를 올리면 얼굴 풍선을 띄운다', () => {
    render(
      <WorldMap
        cities={[city(1, { region: 1, regionName: '하북' }), city(2)]}
        nations={nations}
        onSelect={vi.fn()}
        generals={[general(1, '조조(曹操)', 1, true), general(2, '허저', 1, false)]}
      />,
    );
    const ye = screen.getByRole('button', { name: /^업, 하북, 위/ });
    expect(ye.querySelector('title')?.textContent).toContain('장수 2명: 조조, 허저 NPC');
    fireEvent.pointerMove(ye, { pointerType: 'mouse', clientX: 10, clientY: 10 });
    const balloon = screen.getByTestId('map-tooltip');
    expect(balloon.textContent).toContain('하북 · 특');
    expect(within(balloon).getByTestId('map-tooltip-generals').textContent).toContain('허저NPC');
    fireEvent.pointerLeave(ye);
    expect(screen.queryByTestId('map-tooltip')).toBeNull();
  });

  it('장수를 주지 않는 지도(공개 지도)는 풍선 틀 없이 SVG만 그린다', () => {
    const { container } = render(<WorldMap cities={[city(1)]} nations={nations} />);
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe('svg');
  });
});

describe('도시 제목과 관직', () => {
  const officer = (officerLevel: number, name: string, isHuman: boolean, resident = true) =>
    ({
      generalId: officerLevel * 10,
      name,
      officerLevel,
      isHuman,
      portraitId: officerLevel,
      resident,
    }) as NonNullable<CityView['officers']>[number];

  it('원작 도시 제목처럼 지역과 규모 이름을 괄호에 쓴다', () => {
    expect(cityRegionTitle('하북', 8)).toBe('하북 · 특');
    expect(cityRegionTitle('하북', 99)).toBe('하북 · 규모 99');
  });

  it('태수·군사·종사는 얼굴·이름·NPC·주재를 쓰고 빈 자리는 없음이다', () => {
    render(
      <CityOffices officers={[officer(4, '순욱(荀彧)', false), officer(10, '하후돈', true, false)]} secretaryEnabled />,
    );
    const panel = screen.getByRole('region', { name: '도시 관직' });
    const seat = (title: string) => panel.querySelector(`[data-office="${title}"]`);
    expect(seat('태수')?.textContent).toBe('태수순욱NPC주재');
    expect(seat('태수')?.querySelector('[data-portrait="순욱"]')?.getAttribute('data-shape')).toBe('round');
    expect(seat('군사')?.textContent).toBe('군사없음');
    expect(seat('종사')?.textContent).toBe('종사없음');
    expect(seat('수뇌')?.textContent).toBe('수뇌하후돈부재');
  });

  it('종사 설정이 꺼진 월드는 종사 자리를 두지 않는다', () => {
    expect(cityOfficeSeats([], false).map((seat) => seat.title)).toEqual(['태수', '군사']);
  });

  it('장수 행의 isHuman이 false면 감찰 자료 없이도 NPC 딱지를 단다', () => {
    const npc = { id: 1, name: '여포(呂布)', nationId: 2, isHuman: false } as GeneralView;
    const human = { id: 2, name: '유비', nationId: 2, isHuman: true } as GeneralView;
    const { unmount } = render(<GeneralNameCell general={npc} />);
    expect(screen.getByText('NPC')).toBeTruthy();
    unmount();
    render(<GeneralNameCell general={human} />);
    expect(screen.queryByText('NPC')).toBeNull();
  });
});

describe('국가 성향·총 주민·정산 예상', () => {
  const value = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

  it('다른 국가도 성향과 총 주민을 보인다', () => {
    const other = {
      id: 2,
      name: '촉',
      color: '#008000',
      cityCount: 2,
      generalCount: 3,
      philosophy: '왕도',
      population: 120_000,
      populationMax: 300_000,
    } as unknown as NationView;
    render(<NationSummaryGrid nation={other} generals={[]} power={null} />);
    expect(value('성향')).toBe('왕도');
    expect(value('총 주민')).toBe('120,000 / 300,000');
    expect(value('국고')).toBe('—');
  });

  it('소속국은 다음 세금·세곡·봉급·순수입을 글자와 숫자로 쓴다', () => {
    const row = (year: number, month: number, gross: number) => ({
      year,
      month,
      gross,
      perGeneral: Math.floor(gross / 2 / 4),
      payroll: Math.floor(gross / 2 / 4) * 4,
      net: gross - Math.floor(gross / 2 / 4) * 4,
    });
    const own = {
      id: 1,
      name: '위',
      salaryRate: 0.5,
      financeEstimate: { gold: row(191, 7, 10_000), rice: row(191, 10, 8_000), destination: 'nation' },
    } as unknown as NationView;
    render(<NationFinanceGrid nation={own} />);
    expect(value('세금')).toBe('금 10,000 · 191년 7월');
    expect(value('세곡')).toBe('쌀 8,000 · 191년 10월');
    expect(value('봉급(지급률 50%)')).toBe('금 5,000 · 쌀 4,000');
    expect(value('1인 봉급')).toBe('금 1,250 · 쌀 1,000');
    expect(value('순수입(국고)')).toBe('금 +5,000 · 쌀 +4,000');
  });

  it('도시 자원 월드는 순수입이 도시 창고로 간다고 쓰고, 예상이 없으면 칸을 그리지 않는다', () => {
    const zero = { year: 191, month: 1, gross: 0, perGeneral: 0, payroll: 0, net: 0 };
    const own = {
      financeEstimate: { gold: zero, rice: { ...zero, month: 4 }, destination: 'city' },
    } as unknown as NationView;
    const { unmount } = render(<NationFinanceGrid nation={own} />);
    expect(value('순수입(도시 창고)')).toBe('금 +0 · 쌀 +0');
    unmount();
    const { container } = render(<NationFinanceGrid nation={{ id: 2 } as unknown as NationView} />);
    expect(container.textContent).toBe('');
  });
});

describe('진행 줄 사람 장수 정원', () => {
  it('정원이 있으면 N / 정원, 없으면 수만 쓰고 로비 숫자도 받는다', () => {
    expect(humanQuotaText({ humans: 1234, max: 2000 })).toBe('사람 장수 1,234 / 정원 2,000');
    expect(humanQuotaText({ humans: 12, max: null })).toBe('사람 장수 12');
    expect(humanQuotaText(7)).toBe('사람 장수 7');
    expect(humanQuotaText(undefined)).toBeNull();
  });
});

// 시험 값이 서버 응답 모양을 따르는지 컴파일 때 확인한다.
const _mapGeneralShape: WorldMapResponse['generals'][number] = general(1, '조조', 1, true);
void _mapGeneralShape;
