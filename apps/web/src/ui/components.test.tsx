// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readableTextColor } from './color';
import { DisabledReason } from './DisabledReason';
import { StatTable } from './StatTable';
import { EmptyState, ErrorState } from './States';
import { ValueDelta } from './ValueDelta';

afterEach(cleanup);

describe('ValueDelta', () => {
  it('증가는 + 부호와 up', () => {
    render(<ValueDelta value={1234} />);
    const el = screen.getByText('+1,234');
    expect(el.dataset.trend).toBe('up');
  });

  it('감소는 − 부호와 down', () => {
    render(<ValueDelta value={-56} />);
    expect(screen.getByText('−56').dataset.trend).toBe('down');
  });

  it('0은 ±0과 flat', () => {
    render(<ValueDelta value={0} />);
    expect(screen.getByText('±0').dataset.trend).toBe('flat');
  });
});

describe('StatTable', () => {
  it('숫자 칸은 오른쪽 정렬·고정폭 클래스를 쓴다', () => {
    render(<StatTable rows={[{ label: '인구', value: 152_340, max: 620_500 }]} />);
    const value = screen.getByText('152,340');
    expect(value.classList.contains('num')).toBe(true);
    expect(screen.getByRole('meter', { name: '인구 152340 / 620500' })).toBeTruthy();
  });

  it('공개 범위 밖 값은 —와 이유', () => {
    render(<StatTable rows={[{ label: '성벽', value: null, max: 100, hiddenReason: '다른 국가 정보' }]} />);
    expect(screen.getByText('—').getAttribute('title')).toBe('다른 국가 정보');
    expect(screen.queryByRole('meter')).toBeNull();
  });
});

describe('국가색 글자', () => {
  it('어두운 색에는 흰 글자, 밝은 색에는 검은 글자', () => {
    expect(readableTextColor('#000080')).toBe('#ffffff');
    expect(readableTextColor('#ffd700')).toBe('#000000');
    expect(readableTextColor('잘못된 값')).toBe('#000000');
  });
});

describe('상태 표시', () => {
  it('빈 상태와 오류 상태를 구분한다', () => {
    render(
      <>
        <EmptyState title="기록이 없습니다" />
        <ErrorState title="불러오지 못했습니다" />
      </>,
    );
    expect(screen.getByText('기록이 없습니다').closest('[data-state]')?.getAttribute('data-state')).toBe('empty');
    expect(screen.getByRole('alert').getAttribute('data-state')).toBe('error');
  });
});

describe('DisabledReason', () => {
  it('누르면 이유를 보여 준다', () => {
    render(<DisabledReason reason="교전 중인 상대가 아닙니다">출병</DisabledReason>);
    const button = screen.getByRole('button', { name: /^출병\s*\(사용 불가\)$/ });
    expect(button.dataset.unavailable).toBe('true');
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('note').textContent).toBe('교전 중인 상대가 아닙니다');
  });
});
