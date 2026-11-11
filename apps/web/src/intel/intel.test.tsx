// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelRecordList, IntelRecordsPanel } from './IntelRecordList';
import { cities, enabled, levelOne, levelThree, without } from './test/records';
import {
  OWNER_CHANGED,
  ageLabel,
  crewText,
  crewTypesText,
  levelLabel,
  missingReason,
  ownerChanged,
  recordedAtText,
  techLabel,
} from './view';

afterEach(cleanup);

const cell = (row: HTMLElement, index: number) => within(row).getAllByRole('cell')[index]!;
const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent?.replace(/[▲▼]/g, ''));
const column = (label: string) => headers().indexOf(label);

describe('T4-13 W1 표시 함수', () => {
  it('나이는 0이면 이번 달, 그 밖은 개월 전이다', () => {
    expect(ageLabel(0)).toBe('이번 달');
    expect(ageLabel(1)).toBe('1개월 전');
    expect(ageLabel(12)).toBe('12개월 전');
  });

  it('병력은 받은 구간을 그대로 그린다', () => {
    expect(crewText({ min: 0, max: 0 })).toBe('0');
    expect(crewText({ min: 5_000, max: 9_999 })).toBe('5,000~9,999');
    expect(crewText({ min: 50_000, max: null })).toBe('50,000 이상');
  });

  it('단계·기술·병종 문구', () => {
    expect([1, 2, 3].map((level) => levelLabel(level as 1 | 2 | 3))).toEqual(['많이', '어느 정도', '소문']);
    expect(techLabel('overwhelming')).toBe('압도');
    expect(techLabel('far_behind')).toBe('미미');
    expect(crewTypesText([])).toBe('장수 없음');
    expect(crewTypesText(levelOne().crewTypes!)).toBe('창병 2 · 궁병 1');
  });

  it('기록되지 않은 칸의 이유와 기록 시각', () => {
    expect(missingReason(levelThree(), 'domestic')).toBe('정보를 어느 정도 이상 얻었을 때만 기록됩니다');
    expect(missingReason(levelThree(), 'crewTypes')).toBe('정보를 많이 얻었을 때만 기록됩니다');
    expect(missingReason(levelThree({ owner: null }), 'tech')).toBe('공백지라 비교하지 않습니다');
    expect(recordedAtText(levelOne())).toBe('191년 2월 · 3개월 전');
    expect(recordedAtText(levelOne({ ageMonths: 0 }))).toBe('191년 2월 · 이번 달');
  });

  it('주인이 바뀌었는지는 지금 주인을 알 때만 판정한다', () => {
    expect(ownerChanged(levelOne(), 2)).toBe(false);
    expect(ownerChanged(levelOne(), 3)).toBe(true);
    expect(ownerChanged(levelOne({ owner: null }), null)).toBe(false);
    expect(ownerChanged(levelOne({ owner: null }), 2)).toBe(true);
    expect(ownerChanged(levelOne(), undefined)).toBe(false);
  });
});

describe('T4-13 W2 응답 상태', () => {
  it('꺼진 월드, 재야, 기록 없음, 기록 있음이 서로 다른 화면이다', () => {
    const { rerender } = render(
      <IntelRecordsPanel data={{ enabled: false, items: [] }} ronin={false} cities={cities} />,
    );
    expect(screen.getByText('이 월드에서는 첩보를 쓰지 않습니다')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();

    rerender(<IntelRecordsPanel data={enabled([])} ronin cities={cities} />);
    expect(screen.getByText('국가에 소속되면 나라의 첩보 기록을 봅니다')).toBeTruthy();

    rerender(<IntelRecordsPanel data={enabled([])} ronin={false} cities={cities} />);
    expect(screen.getByText('아직 첩보 기록이 없습니다')).toBeTruthy();
    expect(screen.getByText('예턴에 첩보를 넣으면 그 도시의 그때 값이 기록됩니다.')).toBeTruthy();

    rerender(<IntelRecordsPanel data={enabled([levelOne()])} ronin={false} cities={cities} />);
    expect(screen.getByRole('table', { name: '첩보 기록 1곳' })).toBeTruthy();
    expect(screen.queryByText('아직 첩보 기록이 없습니다')).toBeNull();
  });

  it('다시 불러오기 단추는 넘긴 함수를 부르고 불러오는 동안 막힌다', () => {
    const reload = vi.fn();
    const { rerender } = render(
      <IntelRecordsPanel data={enabled([])} ronin={false} cities={cities} onReload={reload} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    expect(reload).toHaveBeenCalledOnce();
    rerender(<IntelRecordsPanel data={enabled([])} ronin={false} cities={cities} onReload={reload} reloading />);
    expect((screen.getByRole('button', { name: '다시 불러오기' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('T4-13 W3 기록 표', () => {
  it('단계 1은 모든 칸이 값이고 병력은 구간 문구다', () => {
    render(<IntelRecordList records={[levelOne()]} cities={cities} />);
    const row = screen.getByRole('row', { name: '허창 첩보 기록, 3개월 전, 정보 많이' });
    expect(cell(row, column('기록')).textContent).toBe('191년 2월 · 3개월 전');
    expect(cell(row, column('주민')).textContent).toBe('12,345 / 30,000');
    expect(cell(row, column('민심')).textContent).toBe('72.5');
    expect(cell(row, column('병력')).textContent).toBe('5,000~9,999');
    expect(cell(row, column('농업')).textContent).toBe('4,000 / 8,000');
    expect(cell(row, column('병종')).textContent).toBe('창병 2 · 궁병 1');
    expect(cell(row, column('기술')).textContent).toBe('우위');
    expect(within(row).queryByText('—')).toBeNull();
  });

  it('단계 3은 내정·병종·기술 칸이 —이고 이유가 title과 화면 읽기 글에 있다', () => {
    render(<IntelRecordList records={[levelThree()]} cities={cities} />);
    const row = screen.getByRole('row', { name: '완 첩보 기록, 5개월 전, 정보 소문' });
    for (const label of ['농업', '상업', '치안', '수비', '성벽']) {
      const td = cell(row, column(label));
      expect(td.getAttribute('title')).toBe('정보를 어느 정도 이상 얻었을 때만 기록됩니다');
      expect(td.textContent).toBe('—기록 없음, 정보를 어느 정도 이상 얻었을 때만 기록됩니다');
    }
    expect(cell(row, column('병종')).getAttribute('title')).toBe('정보를 많이 얻었을 때만 기록됩니다');
    expect(cell(row, column('기술')).getAttribute('title')).toBe('정보를 많이 얻었을 때만 기록됩니다');
    expect(cell(row, column('주민')).textContent).toBe('12,345 / 30,000');
  });

  it('공백지 기록의 기술 칸은 비교하지 않는다는 이유다', () => {
    render(<IntelRecordList records={[without(levelOne({ owner: null }), 'tech')]} cities={[]} />);
    const row = screen.getAllByRole('row')[1]!;
    expect(cell(row, column('당시 주인')).textContent).toContain('공백지');
    expect(cell(row, column('기술')).getAttribute('title')).toBe('공백지라 비교하지 않습니다');
  });
});

describe('T4-13 W4 당시 주인', () => {
  it('지금 주인과 다르면 표시가 붙고 이름은 기록 값이다', () => {
    render(
      <IntelRecordList
        records={[levelOne(), levelThree({ owner: { id: 2, name: '옛 위', color: '#1f4e9c' } })]}
        cities={cities}
      />,
    );
    const same = screen.getByRole('row', { name: /^허창/ });
    expect(within(same).queryByText(OWNER_CHANGED)).toBeNull();
    const moved = screen.getByRole('row', { name: /^완/ });
    expect(within(moved).getByText('옛 위')).toBeTruthy();
    expect(within(moved).getByText(OWNER_CHANGED)).toBeTruthy();
  });

  it('지도에 없는 도시는 key 숫자로 쓰고 주인 바뀜을 판정하지 않는다', () => {
    render(<IntelRecordList records={[levelOne({ cityKey: 99 })]} cities={cities} />);
    const row = screen.getByRole('row', { name: /^99 첩보 기록/ });
    expect(within(row).queryByText(OWNER_CHANGED)).toBeNull();
  });
});

describe('T4-13 W5 도시 고르기', () => {
  it('도시 단추를 누르면 그 도시 key를 넘긴다', () => {
    const select = vi.fn();
    render(<IntelRecordList records={[levelOne()]} cities={cities} onSelectCity={select} />);
    fireEvent.click(screen.getByRole('button', { name: '허창, 지도에서 보기' }));
    expect(select).toHaveBeenCalledWith(10);
  });

  it('고르기 함수가 없으면 도시 이름은 글자다', () => {
    render(<IntelRecordList records={[levelOne()]} cities={cities} />);
    expect(screen.queryByRole('button', { name: /지도에서 보기/ })).toBeNull();
  });
});

describe('T4-13 W6 정렬', () => {
  it('기본은 받은 순서(최신순)이고 기록 머리글로 오래된 순·최신순이 바뀐다', () => {
    render(<IntelRecordList records={[levelOne(), levelThree()]} cities={cities} />);
    const order = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('aria-label')?.split(' ')[0]);
    expect(order()).toEqual(['허창', '완']);
    const header = screen.getByRole('button', { name: '기록' });
    fireEvent.click(header);
    expect(order()).toEqual(['완', '허창']);
    fireEvent.click(header);
    expect(order()).toEqual(['허창', '완']);
  });
});
