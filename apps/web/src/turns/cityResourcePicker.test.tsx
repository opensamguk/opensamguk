// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TEST_UNIT_SET } from '../battleSim/testUnitSet';
import { worldUnits } from '../battleSim/unitChoices';
import { CommandPicker } from './CommandPicker';

// 명령은 띠 위 세부 메뉴에서 고른다(띠 아래 목록과 검색 칸은 없다). 시험은 그 명령이 든 묶음 패를 차례로 눌러
// 세부 메뉴에 띄운 뒤 그 단추를 돌려준다. 인자 없는 명령은 누르면 바로 들어가고, 인자가 있으면 인자 창이 열린다.
function commandButton(name: string, root: HTMLElement = document.body): HTMLButtonElement {
  const scope = within(root);
  const find = () =>
    scope.queryAllByRole('button', { name }).find((button) => button.closest('[aria-label$="세부 명령"]')) as
      HTMLButtonElement | undefined;
  const open = find();
  if (open) return open;
  for (const bandGroup of scope.getAllByRole('group', { name: '명령 분류' })) {
    for (const plaque of within(bandGroup).getAllByRole('button')) {
      if (plaque.getAttribute('aria-expanded') !== 'true') fireEvent.click(plaque);
      const found = find();
      if (found) return found;
    }
  }
  throw new Error(`세부 메뉴에서 ${name} 명령을 찾지 못했습니다.`);
}
afterEach(cleanup);
it('INT-18C AC-INT-18C 구판의 인자 없는 훈련은 세부 명령을 누르면 바로 넣는다', () => {
  const onPut = vi.fn();
  render(
    <CommandPicker
      commands={[{ key: 'train', name: '훈련', category: 'military', argsSchema: { type: 'object', properties: {} } }]}
      cities={[]}
      nations={[]}
      selectedCityKey={null}
      defaultCrewType={undefined}
      units={worldUnits(TEST_UNIT_SET)}
      blockedReason={null}
      targetLabel="선택"
      focusRef={createRef()}
      onPut={onPut}
    />,
  );
  fireEvent.click(commandButton('훈련'));
  expect(onPut).toHaveBeenCalledWith({ commandKey: 'train', args: {}, explicit: true });
  expect(screen.queryByRole('combobox', { name: '훈련과 사기 대상' })).toBeNull();
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
      units={worldUnits(TEST_UNIT_SET)}
      blockedReason={null}
      targetLabel="선택"
      focusRef={createRef()}
      onPut={onPut}
    />,
  );
  fireEvent.click(commandButton('훈련'));
  fireEvent.change(screen.getByRole('combobox', { name: '훈련과 사기 대상' }), { target: { value: 'city' } });
  const crewGroup = () => screen.getByRole('radiogroup', { name: '병종' });
  expect((within(crewGroup()).getByRole('radio', { checked: true }) as HTMLInputElement).value).toBe('1100');
  fireEvent.click(within(crewGroup()).getByRole('radio', { name: /궁병/ }));
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({
    commandKey: 'train',
    args: { crewType: 1200, target: 'city' },
    explicit: true,
  });
  // 넣으면 입력 화면이 닫힌다. 다시 고르면 기존 부곡 갈래부터 시작한다.
  fireEvent.click(commandButton('훈련'));
  expect((screen.getByRole('combobox', { name: '훈련과 사기 대상' }) as HTMLSelectElement).value).toBe('unit');
  expect(screen.queryByRole('radiogroup', { name: '병종' })).toBeNull();
  fireEvent.change(screen.getByRole('spinbutton', { name: '부곡 번호' }), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({ commandKey: 'train', args: { unitId: 7 }, explicit: true });
});

// 서버 commands.list의 모병 인자: 도시 수비병 갈래(unitId 없음)와 부곡 갈래(unitId: 번호 또는 'new').
const recruitArgs = {
  anyOf: [
    {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, maximum: 1000000 },
        crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      required: ['amount', 'crewType'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, maximum: 1000000 },
        crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
        unitId: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 2147483647 },
            { type: 'string', const: 'new' },
          ],
        },
      },
      required: ['amount', 'crewType'],
      additionalProperties: false,
    },
  ],
};
it('모병은 새 부곡이나 내 부곡에 넣고, 도시 수비병을 고르면 부곡과 target 없이 넣는다', () => {
  const onPut = vi.fn();
  render(
    <CommandPicker
      commands={[{ key: 'recruit', name: '모병', category: 'military', argsSchema: recruitArgs }]}
      cities={[]}
      nations={[]}
      selectedCityKey={null}
      defaultCrewType={1100}
      units={worldUnits(TEST_UNIT_SET)}
      blockedReason={null}
      targetLabel="선택"
      focusRef={createRef()}
      onPut={onPut}
      argContext={{ here: 1, ownNationId: 1, campaignUnits: [{ id: 3, troops: 1200, crewType: 1100 }] }}
    />,
  );
  fireEvent.click(commandButton('모병'));
  // 입력 형식을 풀어 인자 화면이 열리고, 모집 대상은 부곡부터 시작해 새 부곡을 먼저 고른다.
  expect((screen.getByRole('combobox', { name: '모집 대상' }) as HTMLSelectElement).value).toBe('unit');
  const unitChoice = screen.getByRole('combobox', { name: '부곡' }) as HTMLSelectElement;
  expect(unitChoice.value).toBe('new');
  expect([...unitChoice.options].map((option) => option.text)).toEqual(['새 부곡', '부곡 3 · 시험 보병 1,200명']);
  fireEvent.change(screen.getByRole('spinbutton', { name: '수량' }), { target: { value: '100' } });
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({
    commandKey: 'recruit',
    args: { amount: 100, crewType: 1100, unitId: 'new' },
    explicit: true,
  });
  fireEvent.click(commandButton('모병'));
  fireEvent.change(screen.getByRole('combobox', { name: '모집 대상' }), { target: { value: 'city' } });
  expect(screen.queryByRole('combobox', { name: '부곡' })).toBeNull();
  fireEvent.change(screen.getByRole('spinbutton', { name: '수량' }), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: '선택에 넣기' }));
  expect(onPut).toHaveBeenLastCalledWith({
    commandKey: 'recruit',
    args: { amount: 50, crewType: 1100 },
    explicit: true,
  });
});
