// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RELATION_SYMBOL, relationLookup, RelationGridView, type RelationsReply } from './RelationGrid';

// 외교 현황 국가×국가 표 (INT-26). 값은 treaty.relations의 실제 출력 타입으로 만든 손 데이터다.
afterEach(cleanup);

const data: RelationsReply = {
  nations: [
    { id: 1, name: '조조', color: '#336699' },
    { id: 2, name: '원소', color: '#993333' },
    { id: 3, name: '유표', color: '#339966' },
  ],
  pairs: [
    { nationA: 1, nationB: 2, relation: 'WAR', relationEndAt: null },
    { nationA: 1, nationB: 3, relation: 'NON_AGGRESSION', relationEndAt: { year: 192, month: 4 } },
    { nationA: 2, nationB: 3, relation: 'DECLARED', relationEndAt: { year: 191, month: 9 } },
  ],
};

describe('외교 현황 표', () => {
  it('원작 기호 넷을 쓰고 범례에 같은 순서로 적는다', () => {
    expect(Object.values(RELATION_SYMBOL).map((mark) => `${mark.symbol}${mark.label}`)).toEqual([
      '★교전',
      '▲선포',
      '@불가침',
      'ㆍ통상',
    ]);
    render(<RelationGridView data={data} ownNationId={1} />);
    const legend = screen.getByRole('list', { name: '범례' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['★ 교전', '▲ 선포', '@ 불가침', 'ㆍ 통상']);
  });

  it('쌍은 양방향으로 찾는다', () => {
    const find = relationLookup(data.pairs);
    expect(find(2, 1)?.relation).toBe('WAR');
    expect(find(3, 2)?.relation).toBe('DECLARED');
    expect(find(1, 1)).toBeUndefined();
  });

  it('칸마다 기호와 읽을 이름을 두고 대각선은 비운다. 우리 국가 줄·칸에 data-own을 단다', () => {
    render(<RelationGridView data={data} ownNationId={1} />);
    const grid = screen.getByTestId('relation-grid');
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(4);
    const cells = (row: number) => within(rows[row]!).getAllByRole('cell');
    // 조조 줄: 대각선, 원소와 교전, 유표와 불가침(끝나는 달 포함)
    expect(cells(1).map((cell) => cell.dataset.relation ?? 'self')).toEqual(['self', 'WAR', 'NON_AGGRESSION']);
    expect(cells(1)[1]!.textContent).toBe('★조조·원소 교전');
    expect(cells(1)[2]!.textContent).toBe('@조조·유표 불가침 (192년 4월까지)');
    // 원소 줄: 원소에서 본 같은 쌍도 같은 값이다.
    expect(cells(2)[0]!.textContent).toBe('★원소·조조 교전');
    expect(cells(2)[2]!.textContent).toBe('▲원소·유표 선포 (191년 9월까지)');
    // 우리 줄 전체와 다른 줄의 우리 칸만 칠한다.
    expect(cells(1).every((cell) => cell.dataset.own === 'true')).toBe(true);
    expect(cells(2).map((cell) => cell.dataset.own === 'true')).toEqual([true, false, false]);
    expect(cells(3).map((cell) => cell.dataset.own === 'true')).toEqual([true, false, false]);
    const headers = within(rows[0]!).getAllByRole('columnheader');
    expect(headers.map((cell) => cell.textContent)).toEqual(['국가', '조조우리', '원소', '유표']);
    expect(headers[1]!.dataset.own).toBe('true');
    expect(within(rows[1]!).getByRole('rowheader').textContent).toBe('조조우리');
  });

  it('쌍이 없는 칸은 통상으로 둔다', () => {
    render(<RelationGridView data={{ ...data, pairs: [] }} ownNationId={2} />);
    const rows = within(screen.getByTestId('relation-grid')).getAllByRole('row');
    expect(within(rows[1]!).getAllByRole('cell')[1]!.textContent).toBe('ㆍ조조·원소 통상');
  });

  it('국가가 하나뿐이면 표를 그리지 않는다', () => {
    const { container } = render(
      <RelationGridView data={{ nations: data.nations.slice(0, 1), pairs: [] }} ownNationId={1} />,
    );
    expect(container.textContent).toBe('');
  });
});
