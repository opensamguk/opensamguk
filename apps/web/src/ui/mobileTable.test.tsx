// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataTable, type Column } from './DataTable';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function viewport() {
  let narrow = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(value: boolean) {
      act(() => {
        narrow = value;
        for (const listener of listeners) listener();
      });
    },
    listeners,
  };
}
const rows = [
  { id: 1, name: '가', intel: 3, charm: 8 },
  { id: 2, name: '나', intel: 9, charm: 8 },
  { id: 3, name: '다', intel: null, charm: null },
];
const columns: Column<(typeof rows)[number]>[] = [
  { key: 'name', label: '이름', render: (r) => r.name, sortValue: (r) => r.name },
  {
    key: 'intel',
    label: '지력',
    render: (r) => r.intel ?? '—',
    sortValue: (r) => r.intel,
    numeric: true,
    title: (r) => (r.intel === null ? '다른 국가 정보' : undefined),
  },
  { key: 'charm', label: '매력', render: (r) => r.charm ?? '—', sortValue: (r) => r.charm, numeric: true },
];
it('모바일은 모든 값·이유·정렬을 보존하고 폭을 바꿔도 같은 정렬 상태를 쓴다', () => {
  const media = viewport();
  const view = render(
    <DataTable caption="장수" rows={rows} columns={columns} rowKey={(r) => r.id} mobileDetails={['intel', 'charm']} />,
  );
  expect(screen.getAllByRole('columnheader')).toHaveLength(1);
  expect(screen.getAllByRole('row')[3]?.textContent).toContain('지력— (다른 국가 정보)');
  const select = screen.getByRole('combobox', { name: '장수 정렬' });
  expect(within(select).getAllByRole('option')).toHaveLength(4);
  fireEvent.change(select, { target: { value: 'intel' } });
  expect(screen.getAllByRole('row')[1]?.textContent).toContain('나지력9매력8');
  fireEvent.click(screen.getByRole('button', { name: '장수 정렬 방향 내림차순, 바꾸기' }));
  expect(screen.getByRole('button', { name: '장수 정렬 방향 오름차순, 바꾸기' })).toBeTruthy();
  expect(screen.getAllByRole('row')[1]?.textContent).toContain('가지력3매력8');
  expect(screen.getAllByRole('row')[3]?.textContent).toContain('다지력—');
  media.resize(false);
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  expect(screen.getByRole('columnheader', { name: /지력/ }).getAttribute('aria-sort')).toBe('ascending');
  fireEvent.click(screen.getByRole('button', { name: /매력/ }));
  media.resize(true);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('charm');
  expect(screen.getAllByRole('row')[1]?.textContent).toContain('가');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: '장수 정렬 방향 방향 선택, 바꾸기' }).hasAttribute('disabled')).toBe(true);
  view.unmount();
  expect(media.listeners.size).toBe(0);
});

it('명시 목록 없는 표는 모바일에서도 원래 열과 머리글 조작을 유지한다', () => {
  viewport();
  render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} />);
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  expect(screen.queryByRole('combobox')).toBeNull();
});
