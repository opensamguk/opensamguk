// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandPicker } from './CommandPicker';
afterEach(cleanup);
it('INT-18C AC-INT-18C 구판의 인자 없는 훈련은 검색 Enter로 바로 넣는다', () => {
  const onPut = vi.fn();
  render(
    <CommandPicker
      commands={[{ key: 'train', name: '훈련', category: 'military', argsSchema: { type: 'object', properties: {} } }]}
      cities={[]}
      nations={[]}
      selectedCityKey={null}
      defaultCrewType={undefined}
      blockedReason={null}
      targetLabel="선택"
      searchRef={createRef()}
      onPut={onPut}
    />,
  );
  fireEvent.keyDown(screen.getByRole('searchbox', { name: '명령 찾기' }), { key: 'Enter' });
  expect(onPut).toHaveBeenCalledWith({ commandKey: 'train', args: {}, explicit: true });
  expect(screen.queryByRole('combobox', { name: '훈련·사기 대상' })).toBeNull();
});
it('INT-18C AC-INT-18C 도시 훈련 선택은 target city를 보내며 부곡 전환 뒤 숨은 병종을 남기지 않는다', () => {
  const onPut = vi.fn();
  render(
    <CommandPicker
      commands={[
        {
          key: 'train',
          name: '훈련',
          category: 'military',
          argsSchema: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  target: { type: 'string', const: 'city' },
                  crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
                },
                required: ['target', 'crewType'],
              },
              { type: 'object', properties: { unitId: { type: 'integer', minimum: 1 } } },
            ],
          },
        },
      ]}
      cities={[]}
      nations={[]}
      selectedCityKey={null}
      defaultCrewType={1100}
      blockedReason={null}
      targetLabel="선택"
      searchRef={createRef()}
      onPut={onPut}
      cityResources
    />,
  );
  fireEvent.click(screen.getByRole('radio', { name: '훈련' }));
  fireEvent.change(screen.getByRole('combobox', { name: '훈련·사기 대상' }), { target: { value: 'city' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '병종 번호' }), { target: { value: '1100' } });
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({
    commandKey: 'train',
    args: { crewType: 1100, target: 'city' },
    explicit: true,
  });
  fireEvent.change(screen.getByRole('combobox', { name: '훈련·사기 대상' }), { target: { value: 'unit' } });
  expect(screen.queryByRole('spinbutton', { name: '병종 번호' })).toBeNull();
  fireEvent.change(screen.getByRole('spinbutton', { name: '부곡 번호' }), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({ commandKey: 'train', args: { unitId: 7 }, explicit: true });
});
