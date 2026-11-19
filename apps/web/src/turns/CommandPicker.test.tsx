// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TEST_UNIT_SET } from '../battleSim/testUnitSet';
import { worldUnits } from '../battleSim/unitChoices';
import { NationTargetPicker } from './CommandArgsScreen';
import { CommandPicker, type CommandInfo } from './CommandPicker';
import type { EquipmentBoard } from '../equipment/useEquipment';

// 명령은 띠 위 세부 메뉴에서 고르거나 '명령 찾기'로 이름을 걸러 고른다. 이 도우미는 그 명령이 든 묶음 패를 차례로 눌러
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

// 인자 입력 화면(INT-25)은 대상을 목록의 radio로 고른다.
const pickIn = (group: string, name: RegExp) =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
const checkedIn = (group: string) =>
  within(screen.getByRole('radiogroup', { name: group }))
    .queryAllByRole('radio')
    .find((radio) => radio.getAttribute('aria-checked') === 'true' || (radio as HTMLInputElement).checked);
const crewValue = () => (checkedIn('병종') as HTMLInputElement | undefined)?.value ?? '';

function equipmentBoard(): EquipmentBoard {
  const stats = { leadership: 40, strength: 100, intel: 40, politics: 40, charm: 55 };
  return {
    generalId: 7,
    slots: {},
    baseStats: stats,
    stats,
    bonus: { leadership: 0, strength: 0, intel: 0 },
    sellRateBp: 5000,
    tradeExperience: 10,
    items: [
      {
        key: 'horse_01',
        name: '노기',
        slot: 'horse',
        grade: 1,
        cost: 1000,
        requiredSecurity: 1000,
        stat: 'leadership',
        bonus: 1,
        goods: { iron: 0, wood: 0, horses: 5 },
        failure: null,
      },
      {
        key: 'weapon_06',
        name: '소부',
        slot: 'weapon',
        grade: 6,
        cost: 21000,
        requiredSecurity: 6000,
        stat: 'strength',
        bonus: 6,
        goods: { iron: 30, wood: 0, horses: 0 },
        failure: { code: 'NO_GOLD', message: '금이 부족합니다.' },
      },
    ],
    sales: ['horse', 'weapon', 'book'].map((slot) => ({
      slot: slot as 'horse' | 'weapon' | 'book',
      proceeds: 0,
      failure: { code: 'BAD_TARGET', message: '장착한 장비가 없습니다.' },
    })),
  };
}

const equipmentCommand: CommandInfo = {
  key: 'equipment_trade',
  name: '장비매매',
  category: 'personal',
  argsSchema: { type: 'object' },
};

it('T4-24 AC-P2-12 장비는 이름·가격·재료로 고르고 현재 조건이 부족해도 다음 예턴에 예약할 수 있다', () => {
  const input = props({ commands: [equipmentCommand], equipment: { kind: 'ready', data: equipmentBoard() } });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('장비매매'));
  fireEvent.change(screen.getByLabelText('장비 칸'), { target: { value: 'weapon' } });
  const select = screen.getByLabelText('매매할 장비');
  expect(select.tagName).toBe('SELECT');
  fireEvent.change(select, { target: { value: 'weapon_06' } });
  expect(screen.getByText(/치안 6,000 이상 · 철 30/)).toBeTruthy();
  // 지금 상태의 경고는 30칸 표의 사전 검사와 같은 말을 쓰고, 경고가 있어도 넣을 수 있다고 바로 아래에 적는다.
  const warning = screen.getByText('사전 검사 경고: 금이 부족합니다.');
  expect(warning.getAttribute('role')).toBe('note');
  expect(warning.nextElementSibling?.textContent).toContain('경고가 있어도 넣을 수 있고');
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({
    commandKey: 'equipment_trade',
    args: { slot: 'weapon', itemKey: 'weapon_06' },
    explicit: true,
  });
});

it('T4-24 AC-P2-12 장비 칸을 바꾸면 이전 선택을 비워 다른 종류의 장비를 넣지 않는다', () => {
  const input = props({ commands: [equipmentCommand], equipment: { kind: 'ready', data: equipmentBoard() } });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('장비매매'));
  fireEvent.change(screen.getByLabelText('장비 칸'), { target: { value: 'weapon' } });
  fireEvent.change(screen.getByLabelText('매매할 장비'), { target: { value: 'weapon_06' } });
  fireEvent.change(screen.getByLabelText('장비 칸'), { target: { value: 'horse' } });
  expect((screen.getByLabelText('매매할 장비') as HTMLSelectElement).value).toBe('');
  fireEvent.submit(screen.getByRole('form', { name: '장비매매 인자' }));
  expect(input.onPut).not.toHaveBeenCalled();
});

it('T4-24 AC-P2-12 AC-P2-34 장비 재조회가 실패하면 이미 고른 인자도 넣지 않고 공통 오류 칸에서 다시 시도한다', () => {
  const input = props({ commands: [equipmentCommand], equipment: { kind: 'ready', data: equipmentBoard() } });
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('장비매매'));
  fireEvent.change(screen.getByLabelText('매매할 장비'), { target: { value: 'horse_01' } });
  const retry = vi.fn();
  view.rerender(<CommandPicker {...input} equipment={{ kind: 'error', retry }} />);
  fireEvent.submit(screen.getByRole('form', { name: '장비매매 인자' }));
  expect(input.onPut).not.toHaveBeenCalled();
  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('data-state')).toBe('error');
  expect(alert.textContent).toContain('장비 정보를 불러오지 못했습니다.');
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(retry).toHaveBeenCalledOnce();
});

const empty = { type: 'object', properties: {} };
const commands: CommandInfo[] = [
  { key: 'farm', name: '농지 개간', category: 'domestic', argsSchema: empty },
  { key: 'rest', name: '휴식', category: 'personal', argsSchema: empty },
  {
    key: 'move',
    name: '이동',
    category: 'military',
    argsSchema: { type: 'object', properties: { cityKey: { type: 'integer' } }, required: ['cityKey'] },
  },
  { key: 'new-command', name: '새 명령', category: 'new-category', argsSchema: empty },
];

function props(overrides: Partial<Omit<ComponentProps<typeof CommandPicker>, 'onPut'>> = {}) {
  return {
    commands,
    cities: [{ key: 3, name: '진류' }],
    nations: [],
    selectedCityKey: null,
    defaultCrewType: undefined,
    units: worldUnits(TEST_UNIT_SET),
    blockedReason: null,
    targetLabel: '1번 칸',
    focusRef: { current: null },
    onPut: vi.fn(),
    ...overrides,
  };
}

it('명령 찾기로 이름을 걸러 라디오로 고르고, 인자 없는 명령은 칸에 넣기 단추로 넣는다', () => {
  const input = props();
  render(<CommandPicker {...input} />);
  const search = screen.getByLabelText('명령 찾기');
  fireEvent.change(search, { target: { value: '농지' } });
  const found = screen.getByRole('radiogroup', { name: '찾은 명령' });
  expect(
    within(found)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('value')),
  ).toEqual(['farm']);
  // 고르기만 해서는 넣지 않는다. 띠에서 누를 때와 달리 넣기 단추를 눌러야 들어간다.
  fireEvent.click(within(found).getByRole('radio', { name: '농지 개간' }));
  expect(input.onPut).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'farm', args: {}, explicit: true });
  // 없는 이름은 빈 목록 대신 이유를 적고, Enter는 첫 결과를 고른다.
  fireEvent.change(search, { target: { value: '없는 명령' } });
  expect(screen.getByText(/이 든 명령이 없습니다/)).toBeTruthy();
  fireEvent.change(search, { target: { value: '휴식' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(input.onPut).toHaveBeenLastCalledWith({ commandKey: 'rest', args: {}, explicit: true });
});

it('T4-92 AC-P2-29 서버의 새 분류도 분류 패와 세부 명령에 보이며 그 분류의 명령만 띄운다', () => {
  render(<CommandPicker {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'new-category' }));
  const sub = screen.getByRole('group', { name: 'new-category 세부 명령' });
  const card = within(sub).getByRole('button', { name: '새 명령' });
  expect(within(sub).getAllByRole('button')).toEqual([card]);
  expect(card.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe(
    'new-category · 고를 것 없음',
  );
  // 패를 다시 누르면 세부 명령을 닫고, 다른 분류의 명령은 그 분류 패에서 고른다.
  fireEvent.click(screen.getByRole('button', { name: 'new-category' }));
  expect(screen.queryByRole('group', { name: /세부 명령$/ })).toBeNull();
  expect(commandButton('농지 개간')).toBeTruthy();
});

it('세부 명령을 누르면 인자 없는 명령은 바로 넣고 같은 명령을 다시 누르면 다시 넣는다', () => {
  const input = props();
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('농지 개간'));
  fireEvent.click(commandButton('휴식'));
  fireEvent.click(commandButton('휴식'));
  expect(commandButton('농지 개간').getAttribute('aria-pressed')).toBe('false');
  expect(commandButton('휴식').getAttribute('aria-pressed')).toBe('true');
  expect(input.onPut.mock.calls).toEqual([
    [{ commandKey: 'farm', args: {}, explicit: true }],
    [{ commandKey: 'rest', args: {}, explicit: true }],
    [{ commandKey: 'rest', args: {}, explicit: true }],
  ]);
  // 넣기 단추는 없다.
  expect(screen.queryByRole('button', { name: /칸에 넣기/ })).toBeNull();
});

it('필수 인자는 카드 설명과 입력에서 같고 도시를 고른 뒤 숫자 인자를 넣는다', () => {
  const input = props();
  render(<CommandPicker {...input} />);
  const card = commandButton('이동');
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('군사 · 대상 도시 (필수)');
  fireEvent.click(card);
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('대상 도시 칸을 채우세요.');
  expect(input.onPut).not.toHaveBeenCalled();
  pickIn('대상 도시', /^진류/);
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'move', args: { cityKey: 3 }, explicit: true });
  // 넣으면 입력 화면을 닫는다.
  expect(screen.queryByTestId('command-args-screen')).toBeNull();
});

it('저장 불가 사유가 있으면 세부 명령을 눌러도 넣지 않고 이유를 적는다', () => {
  const input = props({ blockedReason: '끝난 판이라 예턴을 바꿀 수 없습니다.' });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('농지 개간'));
  expect(screen.getByRole('note').textContent).toBe(input.blockedReason);
  expect(input.onPut).not.toHaveBeenCalled();
});

it('서버가 고른 명령과 분류를 없애면 고른 상태를 지우고 새 목록으로 고른다', () => {
  const input = props();
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('button', { name: 'new-category' }));
  fireEvent.click(commandButton('새 명령'));
  input.onPut.mockClear();
  view.rerender(<CommandPicker {...input} commands={[commands[0]!]} />);
  expect(screen.queryByRole('button', { name: '새 명령' })).toBeNull();
  expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  expect(commandButton('농지 개간')).toBeTruthy();
  expect(input.onPut).not.toHaveBeenCalled();
});

it('개인 선택기와 국가 선택기의 이름 연결과 고른 상태는 서로 독립이다', () => {
  const personal = props();
  const nation = props({ targetLabel: '국가 1번 칸' });
  render(
    <>
      <CommandPicker {...personal} />
      <CommandPicker {...nation} />
    </>,
  );
  const [first, second] = screen.getAllByRole('region', { name: '명령 고르기' });
  fireEvent.click(commandButton('농지 개간', first!));
  expect(commandButton('농지 개간', first!).getAttribute('aria-pressed')).toBe('true');
  expect(commandButton('농지 개간', second!).getAttribute('aria-pressed')).toBe('false');
  expect(nation.onPut).not.toHaveBeenCalled();
  fireEvent.click(commandButton('농지 개간', second!));
  const selected = [commandButton('농지 개간', first!), commandButton('농지 개간', second!)];
  expect(selected.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
  expect(selected[0]!.getAttribute('aria-labelledby')).not.toBe(selected[1]!.getAttribute('aria-labelledby'));
  expect(personal.onPut).toHaveBeenCalledTimes(1);
  expect(nation.onPut).toHaveBeenCalledTimes(1);
});

it('도시 수비병과 부곡 훈련의 카드 설명은 고른 schema 갈래를 따르고 잘못된 갈래를 인자 없음으로 숨기지 않는다', () => {
  const train: CommandInfo = {
    key: 'train',
    name: '훈련',
    category: 'military',
    argsSchema: {
      anyOf: [
        { type: 'object', properties: { unitId: { type: 'integer', minimum: 1 } } },
        {
          type: 'object',
          properties: { target: { const: 'city' }, crewType: { type: 'integer', minimum: 1 } },
          required: ['target', 'crewType'],
        },
      ],
    },
  };
  const input = props({ commands: [train] });
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('훈련'));
  expect(screen.getByText('군사 · 부곡 번호')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '훈련과 사기 대상' }), { target: { value: 'city' } });
  expect(screen.getByText('군사 · 병종 (필수)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({
    commandKey: 'train',
    args: { crewType: 1100, target: 'city' },
    explicit: true,
  });
  input.onPut.mockClear();
  // 넣으면 입력 화면이 닫히므로 도시 수비병 갈래를 다시 고른 상태에서 서버 schema가 바뀌는 경우를 본다.
  fireEvent.click(commandButton('훈련'));
  fireEvent.change(screen.getByRole('combobox', { name: '훈련과 사기 대상' }), { target: { value: 'city' } });
  view.rerender(<CommandPicker {...input} commands={[{ ...train, argsSchema: empty }]} />);
  expect(screen.getByText('군사 · 입력 형식 확인 필요')).toBeTruthy();
  // 형식을 모르면 인자 창을 닫고 넣지 않으며 이유를 적는다.
  expect(screen.queryByTestId('command-args-screen')).toBeNull();
  expect(screen.getByRole('note').textContent).toBe('명령 입력 형식을 확인하지 못했습니다.');
  fireEvent.click(commandButton('훈련'));
  expect(input.onPut).not.toHaveBeenCalled();
});

it('대상 장수를 이름으로 고르는 칸은 카드·입력·누락 안내가 같은 이름을 쓴다', () => {
  const appoint: CommandInfo = {
    key: 'nation_appoint',
    name: '임명',
    category: 'nation',
    argsSchema: { type: 'object', properties: { generalId: { type: 'integer', minimum: 1 } }, required: ['generalId'] },
  };
  const input = props({ commands: [appoint], generals: [{ id: 7, name: '조운' }] });
  render(<CommandPicker {...input} />);
  const card = commandButton('임명');
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('국가 · 대상 장수 (필수)');
  fireEvent.click(card);
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('대상 장수 칸을 채우세요.');
  pickIn('대상 장수', /^조운/);
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'nation_appoint', args: { generalId: 7 }, explicit: true });
});

it('훈련에서 고른 도시 수비병 갈래를 고르지 않은 사기 카드가 이어받지 않는다', () => {
  const drill = (key: string, name: string): CommandInfo => ({
    key,
    name,
    category: 'military',
    argsSchema: {
      anyOf: [
        { type: 'object', properties: { unitId: { type: 'integer', minimum: 1 } } },
        {
          type: 'object',
          properties: { target: { const: 'city' }, crewType: { type: 'integer', minimum: 1 } },
          required: ['target', 'crewType'],
        },
      ],
    },
  });
  const input = props({ commands: [drill('train', '훈련'), drill('morale', '사기진작')] });
  render(<CommandPicker {...input} />);
  const hint = (name: string) =>
    document.getElementById(commandButton(name).getAttribute('aria-describedby')!)?.textContent;
  fireEvent.click(commandButton('훈련'));
  fireEvent.change(screen.getByRole('combobox', { name: '훈련과 사기 대상' }), { target: { value: 'city' } });
  expect(hint('훈련')).toBe('군사 · 병종 (필수)');
  expect(hint('사기진작')).toBe('군사 · 부곡 번호');
  fireEvent.click(commandButton('사기진작'));
  expect((screen.getByRole('combobox', { name: '훈련과 사기 대상' }) as HTMLSelectElement).value).toBe('unit');
  expect(hint('훈련')).toBe('군사 · 부곡 번호');
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'morale', args: {}, explicit: true });
});

it('서버 목록에서 빠졌다가 다시 온 명령은 옛 선택과 입력값을 되살리지 않는다', () => {
  const input = props();
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('이동'));
  pickIn('대상 도시', /^진류/);
  view.rerender(<CommandPicker {...input} commands={commands.filter((c) => c.key !== 'move')} />);
  view.rerender(<CommandPicker {...input} />);
  expect(commandButton('이동').getAttribute('aria-pressed') === 'true').toBe(false);
  expect(screen.queryByRole('radiogroup', { name: '대상 도시' })).toBeNull();
  fireEvent.click(commandButton('이동'));
  expect(checkedIn('대상 도시')).toBeUndefined();
  expect(input.onPut).not.toHaveBeenCalled();
});

it('월드 규칙을 받기 전 union을 인자 없음으로 표시하거나 눌러도 빈 인자를 넣지 않는다', () => {
  const input = props({
    commands: [{ key: 'train', name: '훈련', category: 'military', argsSchema: { anyOf: [empty, empty] } }],
  });
  render(<CommandPicker {...input} />);
  commandButton('훈련');
  expect(screen.getByText('군사 · 입력 형식 확인 필요')).toBeTruthy();
  fireEvent.click(commandButton('훈련'));
  expect(input.onPut).not.toHaveBeenCalled();
});

it('고른 명령의 서버 사전 검사 경고를 보이고 휴식과 덜 찬 명령은 검사하지 않는다', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const asked: string[] = [];
  const precheck = (turn: { commandKey: string; args: Record<string, unknown> }) => ({
    queryKey: ['precheck', turn.commandKey, turn.args],
    queryFn: () => {
      asked.push(turn.commandKey);
      return Promise.resolve({ ok: false, message: '국가에 소속되어야 합니다.' });
    },
    select: (data: unknown) => data as { ok: false; message: string },
  });
  const onPut = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPicker {...props()} onPut={onPut} precheck={precheck} />
    </QueryClientProvider>,
  );
  fireEvent.click(commandButton('이동'));
  fireEvent.click(commandButton('휴식'));
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(commandButton('농지 개간'));
  expect((await screen.findByRole('status')).textContent).toBe(
    '사전 검사 경고: 국가에 소속되어야 합니다. 경고가 있어도 넣을 수 있습니다. 실행할 때 다시 검사합니다.',
  );
  expect(asked).toEqual(['farm']);
  // 인자 없는 명령은 누르는 순간 들어가고, 경고는 넣은 명령에 대해 그 뒤에 보인다.
  expect(onPut.mock.calls).toEqual([
    [{ commandKey: 'rest', args: {}, explicit: true }],
    [{ commandKey: 'farm', args: {}, explicit: true }],
  ]);
});

it('T4-86 AC-P2-26 병종 칸은 월드 병종표로 고르고 병종표를 불러오는 중에도 병종 없는 명령은 넣는다', () => {
  const recruit: CommandInfo = {
    key: 'recruit',
    name: '징병',
    category: 'military',
    argsSchema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
        crewType: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
      },
      required: ['amount', 'crewType'],
    },
  };
  const input = props({ commands: [recruit, ...commands], units: worldUnits(undefined), unitNote: '불러오는 중' });
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('징병'));
  expect(within(screen.getByRole('radiogroup', { name: '병종' })).queryAllByRole('radio')).toHaveLength(0);
  // 모병은 도시 자원 안내 줄도 note로 함께 보인다.
  expect(screen.getAllByRole('note').map((note) => note.textContent)).toContain('불러오는 중');
  fireEvent.click(commandButton('농지 개간'));
  expect(input.onPut).toHaveBeenLastCalledWith({ commandKey: 'farm', args: {}, explicit: true });

  // 병종표가 오면 지금 거느린 병종, 월드 기본 병종, 첫 장수 병종 순으로 유효한 값을 고른다.
  const loaded = worldUnits(TEST_UNIT_SET);
  view.rerender(<CommandPicker {...input} units={loaded} unitNote={null} defaultCrewType={1300} />);
  fireEvent.click(commandButton('징병'));
  expect(
    within(screen.getByRole('radiogroup', { name: '병종' }))
      .getAllByRole('radio')
      .map((radio) => (radio as HTMLInputElement).value),
  ).toEqual(['1100', '1200', '1300']);
  expect(crewValue()).toBe('1300');
  view.rerender(<CommandPicker {...input} units={loaded} unitNote={null} defaultCrewType={1000} />);
  fireEvent.click(commandButton('농지 개간'));
  fireEvent.click(commandButton('징병'));
  expect(crewValue()).toBe('1100');
  const noDefault = worldUnits({ ...TEST_UNIT_SET, defaultCrewTypeId: 1000 });
  view.rerender(<CommandPicker {...input} units={noDefault} unitNote={null} defaultCrewType={undefined} />);
  fireEvent.click(commandButton('농지 개간'));
  fireEvent.click(commandButton('징병'));
  expect(crewValue()).toBe('1100');
  // 모집 조건이 있는 1300도 고르고 넣을 수 있다. 지금 조건 판정은 서버 사전 검사가 한다.
  pickIn('병종', /기병/);
  fireEvent.change(screen.getByRole('spinbutton', { name: '수량' }), { target: { value: '100' } });
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenLastCalledWith({
    commandKey: 'recruit',
    args: { amount: 100, crewType: 1300 },
    explicit: true,
  });
});

// INT-25 3단계: 인자 입력 화면에 원작(core2026)이 보이던 정보를 우리 서버 조회로 채운다.
const resourceSchema = {
  type: 'object',
  properties: {
    generalId: { type: 'integer', exclusiveMinimum: 0 },
    resource: { type: 'string', enum: ['gold', 'rice'] },
    amount: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
  },
  required: ['generalId', 'resource', 'amount'],
};

it('INT-25 AC-INT-25 포상 대상은 금이 적은 장수부터 `이름 (도시)`·능력치·물자로 보이고 국고와 전부 단추를 쓴다', () => {
  const reward: CommandInfo = { key: 'nation_reward', name: '포상', category: 'nation', argsSchema: resourceSchema };
  const input = props({
    commands: [reward],
    generals: [
      { id: 1, name: '하후돈(夏侯惇)', cityName: '진류', isHuman: false },
      { id: 2, name: '조인', cityName: '허창', isHuman: true },
    ],
    argContext: {
      here: null,
      ownNationId: 1,
      walletKind: 'nation',
      wallet: { gold: 10, rice: 20 },
      treasury: { gold: 52000, rice: 31000 },
      members: [
        { id: 1, name: '하후돈(夏侯惇)', leadership: 90, strength: 92, intel: 60, gold: 900, rice: 50, crew: 3000 },
        { id: 2, name: '조인', leadership: 85, strength: 80, intel: 70, gold: 100, rice: 70, crew: 0 },
      ],
    },
  });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('포상'));
  expect(screen.getByTestId('args-treasury').textContent).toBe('국고 금 52,000 · 쌀 31,000');
  expect(screen.queryByTestId('args-wallet')).toBeNull();
  const rows = within(screen.getByRole('radiogroup', { name: '대상 장수' })).getAllByRole('radio');
  expect(rows.map((row) => row.getAttribute('data-value'))).toEqual(['2', '1']);
  expect(rows[1]!.textContent).toContain('하후돈 (진류)');
  expect(rows[1]!.textContent).not.toContain('夏侯惇');
  expect(rows[1]!.textContent).toContain('NPC');
  expect(rows[1]!.textContent).toContain('통솔 90 · 무력 92 · 지력 60');
  expect(rows[1]!.textContent).toContain('금 900 · 쌀 50');
  // 쌀로 바꾸면 쌀이 적은 장수부터다.
  fireEvent.change(screen.getByRole('combobox', { name: '자원' }), { target: { value: 'rice' } });
  expect(
    within(screen.getByRole('radiogroup', { name: '대상 장수' }))
      .getAllByRole('radio')
      .map((row) => row.getAttribute('data-value')),
  ).toEqual(['1', '2']);
  pickIn('대상 장수', /^조인/);
  expect(screen.getByTestId('picked-general').textContent).toContain('병력 0 · 훈련 0 · 사기 0');
  fireEvent.click(screen.getByRole('button', { name: '전부 31,000' }));
  expect((screen.getByRole('spinbutton', { name: '수량' }) as HTMLInputElement).value).toBe('31000');
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({
    commandKey: 'nation_reward',
    args: { generalId: 2, resource: 'rice', amount: 31000 },
    explicit: true,
  });
});

it('INT-25 AC-INT-25 모병은 현황 줄과 통솔 한도까지의 절반·채우기 단추를 보이고 못 고르는 병종은 사유와 함께 둔다', () => {
  const recruit: CommandInfo = {
    key: 'recruit',
    name: '모병',
    category: 'military',
    argsSchema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
        crewType: { type: 'integer', exclusiveMinimum: 0, maximum: 1000000 },
      },
      required: ['amount', 'crewType'],
    },
  };
  const input = props({
    commands: [recruit],
    defaultCrewType: 1100,
    argContext: {
      here: null,
      ownNationId: 1,
      unitSet: TEST_UNIT_SET as never,
      recruitment: { byCrewType: { '1300': { message: '기술 3,000이 필요합니다.' } } },
      me: { id: 9, leadership: 75, crew: 3000, crewType: 1100, gold: 4200 },
      tech: 1200,
    },
  });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('모병'));
  expect(screen.getByTestId('recruit-status').textContent).toBe(
    '통솔 75(최대 병력 7,500) · 현재 병종 시험 보병 · 현재 병력 3,000 · 금 4,200 · 국가 기술 1,200',
  );
  const blocked = screen.getByRole('radio', { name: /시험 기병/ }).closest('tr')!;
  expect(blocked.getAttribute('data-blocked')).toBe('true');
  expect(blocked.textContent).toContain('불가 기술 3,000이 필요합니다.');
  fireEvent.click(screen.getByRole('button', { name: '절반 2,200명' }));
  expect((screen.getByRole('spinbutton', { name: '수량' }) as HTMLInputElement).value).toBe('2200');
  fireEvent.click(screen.getByRole('button', { name: '채우기 4,500명' }));
  expect((screen.getByRole('spinbutton', { name: '수량' }) as HTMLInputElement).value).toBe('4500');
});

const targetMap = {
  cities: [
    { key: 1, name: '허창', level: 8, nationId: 1, links: [2, 3], x: 0, y: 0, supplied: true },
    { key: 2, name: '진류', level: 6, nationId: 2, links: [1], x: 0, y: 0, supplied: true },
    { key: 3, name: '진', level: 6, nationId: 1, links: [1], x: 0, y: 0, supplied: true },
  ],
  nations: [
    { id: 1, name: '위', color: '#336699', capitalCityKey: 1 },
    { id: 2, name: '촉', color: '#993333', capitalCityKey: 2 },
  ],
  background: null,
};

it('INT-25 AC-INT-25 천도 대상 도시는 `도시명 (국가명)`이고 같은 거리에서 내 국가 도시를 먼저 둔다', () => {
  const capital: CommandInfo = {
    key: 'nation_capital',
    name: '천도',
    category: 'nation',
    argsSchema: { type: 'object', properties: { cityKey: { type: 'integer' } }, required: ['cityKey'] },
  };
  const input = props({
    commands: [capital],
    cities: targetMap.cities,
    argContext: { here: 1, ownNationId: 1, map: targetMap as never },
  });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('천도'));
  const names = within(screen.getByRole('radiogroup', { name: '대상 도시' }))
    .getAllByRole('radio')
    .map((radio) => radio.textContent);
  expect(names[1]).toMatch(/^진 \(위\)/);
  expect(names[2]).toMatch(/^진류 \(촉\)/);
  fireEvent.change(screen.getByRole('searchbox', { name: /대상 도시 찾기/ }), { target: { value: 'ㅈㄹ' } });
  expect(within(screen.getByRole('radiogroup', { name: '대상 도시' })).getAllByRole('radio')).toHaveLength(1);
  expect(screen.getByText('1개 / 3개')).toBeTruthy();
});

it('INT-25 AC-INT-25 대상 국가 카드는 수도·국력·도시·장수와 관계를 적고 사전 검사 불가 국가는 사유와 함께 뒤에 둔다', () => {
  const map = {
    ...targetMap,
    cities: [
      ...targetMap.cities,
      { key: 4, name: '건업', level: 8, nationId: 3, links: [], x: 0, y: 0, supplied: true },
    ],
    nations: [...targetMap.nations, { id: 3, name: '오', color: '#339933', capitalCityKey: 4 }],
  };
  const context = {
    here: 1,
    ownNationId: 1,
    map: map as never,
    nationFacts: new Map([
      [2, { power: 900, cities: 5, generals: 20 }],
      [3, { power: 1200, cities: 7, generals: 25 }],
    ]),
    relations: new Map([[2, '선포 · 12개월 남음']]),
  };
  render(
    <NationTargetPicker
      context={context}
      label="대상 국가"
      value="2"
      options={map.nations.filter((n) => n.id !== 1)}
      onChange={vi.fn()}
      checks={
        new Map([
          [2, { ok: true as const }],
          [3, { ok: false as const, message: '인접 국가가 아닙니다.' }],
        ])
      }
    />,
  );
  const rows = within(screen.getByRole('radiogroup', { name: '대상 국가' })).getAllByRole('radio');
  expect(rows.map((row) => row.getAttribute('data-value'))).toEqual(['2', '3']);
  expect(rows[0]!.textContent).toContain('수도 진류 · 국력 900 · 도시 5 · 장수 20');
  expect(rows[0]!.textContent).toContain('선포 · 12개월 남음');
  expect(rows[0]!.textContent).toContain('가능');
  expect(rows[1]!.textContent).toContain('불가');
  expect(rows[1]!.textContent).toContain('인접 국가가 아닙니다.');
});

it('INT-25 AC-INT-26 명령 도움말이 오면 카드 둘째 줄에 비용을, 인자 화면 안내 줄에 설명·비용·조건·소요 턴을 적는다', () => {
  const move = commands.find((c) => c.key === 'move')!;
  const documented: CommandInfo = {
    ...move,
    description: '이웃 도시로 옮깁니다.',
    cost: '금 50',
    requirements: ['이웃 도시', '보급선'],
    turns: 1,
    available: null,
    reason: '대상이나 값을 고르면 실행 가능 여부를 확인합니다.',
  };
  render(<CommandPicker {...props({ commands: [documented, commands[0]!] })} />);
  const card = commandButton('이동');
  const described = card
    .getAttribute('aria-describedby')!
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual(['금 50', '군사 · 대상 도시 (필수)']);
  // 도움말이 없는 명령은 둘째 줄이 없다.
  expect(commandButton('농지 개간').getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
  // 농지 개간을 찾느라 다른 묶음을 펼쳤으므로 이동 단추를 다시 찾는다.
  fireEvent.click(commandButton('이동'));
  expect(screen.getByTestId('command-description').textContent).toBe('이웃 도시로 옮깁니다.');
  expect(screen.getByTestId('command-cost').textContent).toBe('비용: 금 50');
  expect(screen.getByTestId('command-requirements').textContent).toBe('조건: 이웃 도시 · 보급선');
  expect(screen.getByTestId('command-turns').textContent).toBe('소요 1턴');
});

it('INT-25 INT-26 AC-INT-26 지금 실행할 수 없는 명령은 흐리게 두고 사유를 적지만 고르고 넣을 수 있다', () => {
  const blocked: CommandInfo = {
    ...commands[0]!,
    cost: '금 30',
    available: false,
    reason: '자기 국가 도시가 아닙니다.',
  };
  const needsArgs: CommandInfo = { ...commands.find((c) => c.key === 'move')!, available: null, reason: '인자 필요' };
  const ok: CommandInfo = { ...commands[1]!, available: true, reason: null };
  const input = props({ commands: [blocked, needsArgs, ok] });
  render(<CommandPicker {...input} />);
  const card = commandButton('농지 개간');
  expect(card.getAttribute('data-available')).toBe('false');
  const described = card
    .getAttribute('aria-describedby')!
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual(['금 30', '자기 국가 도시가 아닙니다.', '내정 · 고를 것 없음']);
  // null은 인자를 골라야 판정하므로 흐리지 않고 사유도 적지 않는다. true도 그대로다.
  // 세부 메뉴는 한 묶음씩 펼치므로 사유 줄도 묶음마다 센다.
  expect(screen.getAllByTestId('command-reason')).toHaveLength(1);
  for (const name of ['이동', '휴식']) {
    expect(commandButton(name).getAttribute('data-available')).toBeNull();
    expect(screen.queryAllByTestId('command-reason')).toHaveLength(0);
  }
  // 흐린 명령도 누르면 바로 넣는다.
  fireEvent.click(commandButton('농지 개간'));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'farm', args: {}, explicit: true });
});

const invite: CommandInfo = {
  key: 'invite',
  name: '등용',
  category: 'personal',
  argsSchema: { type: 'object', properties: { generalId: { type: 'integer', minimum: 1 } }, required: ['generalId'] },
};

it('INT-25 INT-26 AC-INT-26 등용은 번호 대신 등용 후보 재야 장수를 얼굴·`이름 (도시)`·NPC 표시로 고른다', () => {
  const onNeed = vi.fn();
  const input = props({
    commands: [invite],
    onNeed,
    argContext: {
      here: null,
      ownNationId: 1,
      recruits: {
        list: [
          { id: 21, name: '서서(徐庶)', portraitId: 5, isHuman: false, cityName: '신야' },
          { id: 22, name: '방통', portraitId: null, isHuman: true, cityName: '양양' },
        ],
        note: null,
      },
    },
  });
  render(<CommandPicker {...input} />);
  const card = commandButton('등용');
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('개인 · 대상 장수 (필수)');
  fireEvent.click(card);
  expect(onNeed).toHaveBeenCalledWith('recruits');
  expect(onNeed).not.toHaveBeenCalledWith('generals');
  // 번호 입력은 없다.
  expect(screen.queryByRole('spinbutton')).toBeNull();
  const rows = within(screen.getByRole('radiogroup', { name: '대상 장수' })).getAllByRole('radio');
  expect(rows.map((row) => row.getAttribute('data-value')).sort()).toEqual(['21', '22']);
  const seo = rows.find((row) => row.getAttribute('data-value') === '21')!;
  expect(seo.textContent).toContain('서서 (신야)');
  expect(seo.textContent).toContain('NPC');
  expect(rows.find((row) => row.getAttribute('data-value') === '22')!.textContent).not.toContain('NPC');
  pickIn('대상 장수', /^서서/);
  expect(screen.getByText('등용 · 서서')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'invite', args: { generalId: 21 }, explicit: true });
});

it('INT-26 AC-INT-26 등용 후보를 불러오는 중이면 빈 목록 대신 안내를 적고 넣지 않는다', () => {
  const input = props({
    commands: [invite],
    argContext: { here: null, ownNationId: 1, recruits: { list: [], note: '등용 후보를 불러오는 중입니다.' } },
  });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('등용'));
  const group = screen.getByRole('radiogroup', { name: '대상 장수' });
  expect(within(group).getByRole('note').textContent).toBe('등용 후보를 불러오는 중입니다.');
  expect(within(group).queryByText('등용할 수 있는 재야 장수가 없습니다')).toBeNull();
  expect(input.onPut).not.toHaveBeenCalled();
});

it('INT-25 AC-INT-25 개인 예턴의 선양은 같은 국가 장수(나 제외)를 이름으로 고른다', () => {
  const abdicate: CommandInfo = {
    key: 'abdicate',
    name: '선양',
    category: 'strategy',
    argsSchema: { type: 'object', properties: { generalId: { type: 'integer' } }, required: ['generalId'] },
  };
  const input = props({
    commands: [abdicate],
    argContext: {
      here: null,
      ownNationId: 1,
      me: { id: 9, leadership: 50, crew: 0, crewType: 1100, gold: 0 },
      members: [
        { id: 9, name: '조조', cityName: '허창', leadership: 90, strength: 72, intel: 91 },
        { id: 10, name: '조비', cityName: '업', leadership: 70, strength: 60, intel: 80 },
      ],
    },
  });
  render(<CommandPicker {...input} />);
  const card = commandButton('선양');
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('전략 · 대상 장수 (필수)');
  fireEvent.click(card);
  const rows = within(screen.getByRole('radiogroup', { name: '대상 장수' })).getAllByRole('radio');
  expect(rows.map((row) => row.getAttribute('data-value'))).toEqual(['10']);
  expect(rows[0]!.textContent).toContain('조비 (업)');
  expect(rows[0]!.textContent).toContain('통솔 70 · 무력 60 · 지력 80');
});

it('D-099 묶음 패를 누르면 세부 명령 띠가 펼쳐지고 띠에서 명령을 고른다', () => {
  render(<CommandPicker {...props()} />);
  expect(screen.queryByRole('group', { name: /세부 명령$/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '내정' }));
  const sub = screen.getByRole('group', { name: '내정 세부 명령' });
  // 세부 명령은 깃발, 이름표 모양 단추로 고른다. 띠 아래 목록과 라디오는 없다.
  const farm = within(sub).getByRole('button', { name: '농지 개간' });
  expect(farm.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(farm);
  expect(farm.getAttribute('aria-pressed')).toBe('true');
  expect(farm.getAttribute('data-checked')).toBe('true');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(document.querySelector('fieldset legend')).toBeNull();
});

it('D-100 권한 밖 명령은 넣기 대신 사유를 적어 권한자에게 제안한다', () => {
  const onPropose = vi.fn();
  const input = props({ propose: { to: '군주', onPropose } });
  render(<CommandPicker {...input} />);
  fireEvent.click(commandButton('농지 개간'));
  expect(screen.queryByRole('button', { name: /에 넣기/ })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: /군주에게 올릴 사유/ }), {
    target: { value: '군량이 모자랍니다' },
  });
  fireEvent.click(screen.getByRole('button', { name: '군주에게 제안하기' }));
  expect(onPropose).toHaveBeenCalledWith(expect.objectContaining({ commandKey: 'farm' }), '군량이 모자랍니다');
  expect(input.onPut).not.toHaveBeenCalled();
});
