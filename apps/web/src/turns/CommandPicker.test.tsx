// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TEST_UNIT_SET } from '../battleSim/testUnitSet';
import { worldUnits } from '../battleSim/unitChoices';
import { CommandPicker, type CommandInfo } from './CommandPicker';
import type { EquipmentBoard } from '../equipment/useEquipment';

afterEach(cleanup);

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
  fireEvent.click(screen.getByRole('radio', { name: '장비매매' }));
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
  fireEvent.click(screen.getByRole('radio', { name: '장비매매' }));
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
  fireEvent.click(screen.getByRole('radio', { name: '장비매매' }));
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
    searchRef: { current: null },
    onPut: vi.fn(),
    ...overrides,
  };
}

it('T4-92 AC-P2-29 서버의 새 분류도 카드와 분류 단추에 보이며 검색과 함께 거른다', () => {
  render(<CommandPicker {...props()} />);
  expect(screen.getAllByRole('radio')).toHaveLength(commands.length);
  const card = screen.getByRole('radio', { name: '새 명령' });
  expect(card.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe(
    'new-category · 고를 것 없음',
  );
  fireEvent.click(screen.getByRole('button', { name: 'new-category' }));
  expect(screen.getAllByRole('radio')).toEqual([card]);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '농지' } });
  expect(screen.queryByRole('radio')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '전체' }));
  expect(screen.getByRole('radio', { name: '농지 개간' })).toBeTruthy();
});

it('카드 선택은 하나이고 선택만으로 명령을 넣지 않으며 같은 명령을 반복해서 넣을 수 있다', () => {
  const input = props();
  render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('radio', { name: '휴식' }));
  expect((screen.getByRole('radio', { name: '농지 개간' }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('radio', { name: '휴식' }) as HTMLInputElement).checked).toBe(true);
  expect(input.onPut).not.toHaveBeenCalled();
  const put = screen.getByRole('button', { name: '1번 칸에 넣기' });
  fireEvent.click(put);
  fireEvent.click(put);
  expect(input.onPut.mock.calls).toEqual([
    [{ commandKey: 'rest', args: {}, explicit: true }],
    [{ commandKey: 'rest', args: {}, explicit: true }],
  ]);
});

it('필수 인자는 카드 설명과 입력에서 같고 도시를 고른 뒤 숫자 인자를 넣는다', () => {
  const input = props();
  render(<CommandPicker {...input} />);
  const card = screen.getByRole('radio', { name: '이동' });
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('군사 · 대상 도시 (필수)');
  fireEvent.click(card);
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('대상 도시 칸을 채우세요.');
  expect(input.onPut).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: '대상 도시' }), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'move', args: { cityKey: 3 }, explicit: true });
});

it('저장 불가 사유가 있으면 카드·넣기·검색 Enter로도 입력을 보내지 않는다', () => {
  const input = props({ blockedReason: '끝난 판이라 예턴을 바꿀 수 없습니다.' });
  render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe(input.blockedReason);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '농지' } });
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
  expect(input.onPut).not.toHaveBeenCalled();
});

it('서버가 고른 명령과 분류를 없애면 입력을 차단하고 새 목록의 전체 카드를 보인다', () => {
  const input = props();
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('button', { name: 'new-category' }));
  fireEvent.click(screen.getByRole('radio', { name: '새 명령' }));
  view.rerender(<CommandPicker {...input} commands={[commands[0]!]} />);
  expect(screen.queryByRole('radio', { name: '새 명령' })).toBeNull();
  expect(screen.getByRole('button', { name: '전체' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('radio', { name: '농지 개간' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('명령을 고르세요.');
  expect(input.onPut).not.toHaveBeenCalled();
});

it('개인·국가 두 선택기의 이름 연결과 radio 그룹은 서로 독립이다', () => {
  render(
    <>
      <CommandPicker {...props()} />
      <CommandPicker {...props({ targetLabel: '국가 1번 칸' })} />
    </>,
  );
  const pickers = screen.getAllByRole('region', { name: '명령 고르기' });
  for (const picker of pickers) fireEvent.click(within(picker).getByRole('radio', { name: '농지 개간' }));
  const selected = screen.getAllByRole('radio', { name: '농지 개간' }) as HTMLInputElement[];
  expect(selected.every((radio) => radio.checked)).toBe(true);
  expect(selected[0]!.name).not.toBe(selected[1]!.name);
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
  const input = props({ commands: [train], cityResources: true });
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('radio', { name: '훈련' }));
  expect(screen.getByText('군사 · 부곡 번호')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '훈련·사기 대상' }), { target: { value: 'city' } });
  expect(screen.getByText('군사 · 병종 (필수)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({
    commandKey: 'train',
    args: { crewType: 1100, target: 'city' },
    explicit: true,
  });
  input.onPut.mockClear();
  view.rerender(<CommandPicker {...input} commands={[{ ...train, argsSchema: empty }]} />);
  expect(screen.getByText('군사 · 입력 형식 확인 필요')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(input.onPut).not.toHaveBeenCalled();
});

it('검색 Enter는 서버 응답 순서가 아니라 화면 분류 순서의 첫 카드를 넣는다', () => {
  const input = props({
    commands: [
      { key: 'rest', name: '휴식', category: 'personal', argsSchema: empty },
      { key: 'farm', name: '농지 개간', category: 'domestic', argsSchema: empty },
    ],
  });
  render(<CommandPicker {...input} />);
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['farm', 'rest']);
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'farm', args: {}, explicit: true });
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
  const card = screen.getByRole('radio', { name: '임명' });
  expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('국가 · 대상 장수 (필수)');
  fireEvent.click(card);
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('대상 장수 칸을 채우세요.');
  fireEvent.change(screen.getByRole('combobox', { name: '대상 장수' }), { target: { value: '7' } });
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
  const input = props({ commands: [drill('train', '훈련'), drill('morale', '사기진작')], cityResources: true });
  render(<CommandPicker {...input} />);
  const hint = (name: string) =>
    document.getElementById(screen.getByRole('radio', { name }).getAttribute('aria-describedby')!)?.textContent;
  fireEvent.click(screen.getByRole('radio', { name: '훈련' }));
  fireEvent.change(screen.getByRole('combobox', { name: '훈련·사기 대상' }), { target: { value: 'city' } });
  expect(hint('훈련')).toBe('군사 · 병종 (필수)');
  expect(hint('사기진작')).toBe('군사 · 부곡 번호');
  fireEvent.click(screen.getByRole('radio', { name: '사기진작' }));
  expect((screen.getByRole('combobox', { name: '훈련·사기 대상' }) as HTMLSelectElement).value).toBe('unit');
  expect(hint('훈련')).toBe('군사 · 부곡 번호');
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenCalledWith({ commandKey: 'morale', args: {}, explicit: true });
});

it('서버 목록에서 빠졌다가 다시 온 명령은 옛 선택과 입력값을 되살리지 않는다', () => {
  const input = props();
  const view = render(<CommandPicker {...input} />);
  fireEvent.click(screen.getByRole('radio', { name: '이동' }));
  fireEvent.change(screen.getByRole('combobox', { name: '대상 도시' }), { target: { value: '3' } });
  view.rerender(<CommandPicker {...input} commands={commands.filter((c) => c.key !== 'move')} />);
  view.rerender(<CommandPicker {...input} />);
  expect((screen.getByRole('radio', { name: '이동' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('combobox', { name: '대상 도시' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^1번 칸에 넣기\s*\(사용 불가\)$/ }));
  expect(screen.getByRole('note').textContent).toBe('명령을 고르세요.');
  fireEvent.click(screen.getByRole('radio', { name: '이동' }));
  expect((screen.getByRole('combobox', { name: '대상 도시' }) as HTMLSelectElement).value).toBe('');
  expect(input.onPut).not.toHaveBeenCalled();
});

it('월드 규칙을 받기 전 union을 인자 없음으로 표시하거나 검색 Enter로 빈 인자를 넣지 않는다', () => {
  const input = props({
    commands: [{ key: 'train', name: '훈련', category: 'military', argsSchema: { anyOf: [empty, empty] } }],
  });
  render(<CommandPicker {...input} />);
  expect(screen.getByText('군사 · 입력 형식 확인 필요')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
  expect(input.onPut).not.toHaveBeenCalled();
});

it('넣기 전에 고른 명령의 서버 사전 검사 경고를 보이고 휴식과 덜 찬 명령은 검사하지 않는다', async () => {
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
  fireEvent.click(screen.getByRole('radio', { name: '이동' }));
  fireEvent.click(screen.getByRole('radio', { name: '휴식' }));
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  expect((await screen.findByRole('status')).textContent).toBe(
    '사전 검사 경고: 국가에 소속되어야 합니다. 경고가 있어도 넣을 수 있습니다. 실행할 때 다시 검사합니다.',
  );
  expect(asked).toEqual(['farm']);
  fireEvent.click(screen.getByRole('button', { name: /1번 칸에 넣기/ }));
  expect(onPut).toHaveBeenCalledWith({ commandKey: 'farm', args: {}, explicit: true });
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
  fireEvent.click(screen.getByRole('radio', { name: '징병' }));
  const crew = () => screen.getByRole('combobox', { name: '병종' }) as HTMLSelectElement;
  expect([...crew().options].map((option) => option.textContent)).toEqual(['고르세요']);
  expect(screen.getByRole('note').textContent).toBe('불러오는 중');
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenLastCalledWith({ commandKey: 'farm', args: {}, explicit: true });

  // 병종표가 오면 지금 거느린 병종, 월드 기본 병종, 첫 장수 병종 순으로 유효한 값을 고른다.
  const loaded = worldUnits(TEST_UNIT_SET);
  view.rerender(<CommandPicker {...input} units={loaded} unitNote={null} defaultCrewType={1300} />);
  fireEvent.click(screen.getByRole('radio', { name: '징병' }));
  expect([...crew().options].map((option) => option.value)).toEqual(['1100', '1200', '1300']);
  expect(crew().value).toBe('1300');
  view.rerender(<CommandPicker {...input} units={loaded} unitNote={null} defaultCrewType={1000} />);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('radio', { name: '징병' }));
  expect(crew().value).toBe('1100');
  const noDefault = worldUnits({ ...TEST_UNIT_SET, defaultCrewTypeId: 1000 });
  view.rerender(<CommandPicker {...input} units={noDefault} unitNote={null} defaultCrewType={undefined} />);
  fireEvent.click(screen.getByRole('radio', { name: '농지 개간' }));
  fireEvent.click(screen.getByRole('radio', { name: '징병' }));
  expect(crew().value).toBe('1100');
  // 모집 조건이 있는 1300도 고르고 넣을 수 있다. 지금 조건 판정은 서버 사전 검사가 한다.
  fireEvent.change(crew(), { target: { value: '1300' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '수량' }), { target: { value: '100' } });
  fireEvent.click(screen.getByRole('button', { name: '1번 칸에 넣기' }));
  expect(input.onPut).toHaveBeenLastCalledWith({
    commandKey: 'recruit',
    args: { amount: 100, crewType: 1300 },
    explicit: true,
  });
});
