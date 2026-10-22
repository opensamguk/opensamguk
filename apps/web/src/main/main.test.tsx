// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapCity } from '../game/types';
import { DataTable, sortRows } from '../ui/DataTable';
import { careTags } from './NationInfo';
import { cityLabel, cityRadius, mapLinks, WorldMap } from './WorldMap';

afterEach(cleanup);

const city = (key: number, links: number[], extra: Partial<MapCity> = {}): MapCity => ({
  key,
  name: `도시${key}`,
  level: 5,
  x: key * 10,
  y: key * 10,
  nationId: null,
  supplied: true,
  links,
  ...extra,
});

describe('지도 계산', () => {
  it('양쪽에 있는 연결은 한 번만 그리고 없는 도시는 버린다', () => {
    const links = mapLinks([city(1, [2, 3]), city(2, [1, 99]), city(3, [1])]);
    expect(links.map(([a, b]) => `${a.key}-${b.key}`)).toEqual(['1-2', '1-3']);
  });

  it('규모가 클수록 점이 크고 범위를 벗어나면 자른다', () => {
    expect(cityRadius(8)).toBeGreaterThan(cityRadius(1));
    expect(cityRadius(20)).toBe(cityRadius(8));
  });

  it('접근 가능한 이름에 소속·보급 끊김·내 위치를 글자로 담는다', () => {
    const nation = { id: 1, name: '위', color: '#000080' };
    expect(cityLabel(city(1, [], { supplied: false, nationId: 1 }), nation, true)).toBe(
      '도시1, 위, 보급 끊김, 내 위치',
    );
    expect(cityLabel(city(3, [], { supplied: false }), undefined, false)).toBe('도시3, 공백지');
    expect(cityLabel(city(2, []), undefined, false)).toBe('도시2, 공백지');
  });

  it('도시를 누르거나 Enter를 치면 onSelect로 알리고 내 도시를 표시한다', () => {
    const onSelect = vi.fn();
    const nations = [{ id: 1, name: '위', color: '#000080' }];
    const nations2 = [...nations, { id: 2, name: '오', color: '#ff0000' }];
    const cities = [city(1, [2], { nationId: 1 }), city(2, [1], { supplied: false, nationId: 2 })];
    render(<WorldMap cities={cities} nations={nations2} myCityKey={1} selectedKey={2} onSelect={onSelect} />);
    const mine = screen.getByRole('button', { name: '도시1, 위, 내 위치' });
    expect(mine.getAttribute('data-mine')).toBe('true');
    const other = screen.getByRole('button', { name: '도시2, 오, 보급 끊김' });
    expect(other.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('data-cut')).toBe('true');
    fireEvent.click(mine);
    fireEvent.keyDown(other, { key: 'Enter' });
    expect(onSelect.mock.calls).toEqual([[1], [2]]);
  });
});

describe('정렬 표', () => {
  it('숫자는 크기순, 공개 범위 밖(null)은 항상 뒤', () => {
    const rows = [{ v: 3 }, { v: null }, { v: 10 }];
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([10, 3, null]);
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([3, 10, null]);
  });

  it('머리글을 누르면 정렬 방향이 aria-sort로 바뀐다', () => {
    render(
      <DataTable
        rows={[
          { id: 1, name: '가', crew: 5 },
          { id: 2, name: '나', crew: 50 },
        ]}
        rowKey={(r) => r.id}
        columns={[
          { key: 'name', label: '이름', sortValue: (r) => r.name, render: (r) => r.name },
          { key: 'crew', label: '병력', numeric: true, sortValue: (r) => r.crew, render: (r) => r.crew },
        ]}
      />,
    );
    const header = screen.getByRole('columnheader', { name: /병력/ });
    fireEvent.click(screen.getByRole('button', { name: /병력/ }));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(screen.getAllByRole('row')[1]!.textContent).toContain('나');
    fireEvent.click(screen.getByRole('button', { name: /병력/ }));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getAllByRole('row')[1]!.textContent).toContain('가');
    expect(header.classList.contains('num')).toBe(true);
  });
});

describe('관리 필요 표시', () => {
  it('부상, 병력이 있을 때 훈련·사기 부족만 표시한다', () => {
    expect(careTags({ injury: 3, crew: 100, train: 40, atmos: 80 })).toEqual(['부상 3', '훈련 부족']);
    expect(careTags({ injury: 0, crew: 0, train: 0, atmos: 0 })).toEqual([]);
  });
});
