import { describe, expect, it } from 'vitest';
import {
  CommandCatalogError,
  renderCommandCatalog,
  type CatalogCommand,
  type CatalogInput,
  type CatalogIssue,
} from './command-catalog';

function fixture(): CatalogInput {
  const command = (
    values: Partial<CatalogCommand> & Pick<CatalogCommand, 'key' | 'name' | 'category'>,
  ): CatalogCommand => ({
    target: 'general',
    summary: '시험 명령을 실행한다',
    inputFields: [],
    requires: [],
    cost: null,
    unavailableIn: [],
    ...values,
  });
  return {
    categories: [
      { id: 'domestic', heading: '내정' },
      { id: 'military', heading: '군사' },
      { id: 'strategy', heading: '인사' },
      { id: 'personal', heading: '개인' },
      { id: 'nation', heading: '국가' },
    ],
    fieldLabels: { amount: '수량', cityKey: '도시' },
    commands: [
      command({ key: 'rest', name: '휴식', category: 'personal', summary: '쉰다' }),
      command({ key: 'nation_rest', name: '휴식', category: 'nation', target: 'nation', summary: '국가가 쉰다' }),
      command({
        key: 'recruit',
        name: '모병',
        category: 'military',
        summary: '병사를 뽑는다',
        inputFields: ['amount', 'cityKey'],
        requires: ['내 도시 | 보급 연결', '<b>재야</b> & 군주 제외'],
        cost: '금 100',
        unavailableIn: ['작은 월드', '빠른 월드'],
      }),
      command({ key: 'farm', name: '농지개간', category: 'domestic', summary: '농지를 늘린다', cost: '금 50' }),
      command({
        key: 'move',
        name: '이동',
        category: 'military',
        summary: '도시로 이동한다',
        inputFields: ['cityKey'],
        unavailableIn: ['작은 월드'],
      }),
      command({ key: 'resign', name: '하야', category: 'strategy', summary: '국가를 떠난다' }),
    ],
  };
}

function withCommand(index: number, patch: Partial<CatalogCommand>, input = fixture()): CatalogInput {
  return { ...input, commands: input.commands.map((command, i) => (i === index ? { ...command, ...patch } : command)) };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function issuesFor(input: CatalogInput): readonly CatalogIssue[] {
  try {
    renderCommandCatalog(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CommandCatalogError);
    if (error instanceof CommandCatalogError) return error.issues;
    throw error;
  }
  throw new Error('Expected CommandCatalogError');
}

const expectedDocument =
  String.raw`<!-- 직접 수정 금지. 생성 명령: pnpm docs:generate -->

# 명령 목록

## 장수 명령

### 내정

| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |
| --- | --- | --- | --- | --- | --- |
| 내정 | 농지개간 | 농지를 늘린다 | 없음 | 없음 | 금 50 |

### 군사

| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |
| --- | --- | --- | --- | --- | --- |
| 군사 | 모병 | 병사를 뽑는다 | 수량, 도시 | 내 도시 \| 보급 연결<br>&lt;b&gt;재야&lt;/b&gt; &amp; 군주 제외<br>일부 월드에서는 쓸 수 없음: 작은 월드, 빠른 월드 | 금 100 |
| 군사 | 이동 | 도시로 이동한다 | 도시 | 일부 월드에서는 쓸 수 없음: 작은 월드 | 없음 |

### 인사

| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |
| --- | --- | --- | --- | --- | --- |
| 인사 | 하야 | 국가를 떠난다 | 없음 | 없음 | 없음 |

### 개인

| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |
| --- | --- | --- | --- | --- | --- |
| 개인 | 휴식 | 쉰다 | 없음 | 없음 | 없음 |

## 국가 명령

### 국가

| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |
| --- | --- | --- | --- | --- | --- |
| 국가 | 휴식 | 국가가 쉰다 | 없음 | 없음 | 없음 |` + '\n';

const emptyDocument = '<!-- 직접 수정 금지. 생성 명령: pnpm docs:generate -->\n\n# 명령 목록\n';

describe('renderCommandCatalog output contract', () => {
  it('renders the exact document in target, category and registration order without changing frozen input', () => {
    const input = deepFreeze(fixture());
    const before = structuredClone(input);
    const first = renderCommandCatalog(input);
    const second = renderCommandCatalog(input);
    expect(first).toBe(expectedDocument);
    expect(Buffer.from(first)).toEqual(Buffer.from(second));
    expect(first).not.toContain('\r');
    expect(first).toMatch(/[^\n]\n$/);
    expect(input).toEqual(before);
  });

  it('omits categories with no rows within each target', () => {
    const input = fixture();
    const result = renderCommandCatalog({
      ...input,
      commands: input.commands.filter((command) => command.key !== 'resign'),
    });
    const removed =
      '### 인사\n\n| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |\n' +
      '| --- | --- | --- | --- | --- | --- |\n| 인사 | 하야 | 국가를 떠난다 | 없음 | 없음 | 없음 |\n\n';
    expect(result).toBe(expectedDocument.replace(removed, ''));
  });

  it('omits an empty target section', () => {
    const input = fixture();
    expect(
      renderCommandCatalog({ ...input, commands: input.commands.filter((command) => command.target === 'general') }),
    ).toBe(expectedDocument.slice(0, expectedDocument.indexOf('\n\n## 국가 명령')) + '\n');
  });

  it('returns exactly the header and title for an empty command list', () => {
    expect(renderCommandCatalog({ ...fixture(), commands: [] })).toBe(emptyDocument);
    expect(renderCommandCatalog({ categories: [], fieldLabels: {}, commands: [] })).toBe(emptyDocument);
  });

  it('allows the same key and name across targets', () => {
    expect(renderCommandCatalog(withCommand(1, { key: 'rest' }))).toBe(expectedDocument);
  });

  it('allows the same category in both targets', () => {
    const result = renderCommandCatalog(withCommand(1, { category: 'military' }));
    expect(result).toBe(
      expectedDocument
        .replace('## 국가 명령\n\n### 국가', '## 국가 명령\n\n### 군사')
        .replace('| 국가 | 휴식 |', '| 군사 | 휴식 |'),
    );
  });

  it('preserves backslashes and pipes before joining condition items', () => {
    const input = fixture();
    const requires = [...input.commands[2]!.requires, String.raw`a\|b`, String.raw`a\b`];
    const result = renderCommandCatalog(withCommand(2, { requires }, input));
    expect(result).toBe(
      expectedDocument.replace(
        '<br>일부 월드에서는 쓸 수 없음: 작은 월드, 빠른 월드',
        String.raw`<br>a\\\|b<br>a\\b<br>일부 월드에서는 쓸 수 없음: 작은 월드, 빠른 월드`,
      ),
    );
  });

  it('escapes all table text while preserving category heading source and surrounding spaces', () => {
    const text = String.raw`  &<x>|\  `;
    const escaped = String.raw`  &amp;&lt;x&gt;\|\\  `;
    const input = fixture();
    const result = renderCommandCatalog({
      categories: [{ id: 'domestic', heading: text }],
      fieldLabels: { amount: text },
      commands: [
        {
          ...input.commands[0]!,
          category: 'domestic',
          name: text,
          summary: text,
          inputFields: ['amount'],
          requires: [text],
          cost: text,
          unavailableIn: [text],
        },
      ],
    });
    expect(result).toContain(`### ${text}\n`);
    expect(result).toContain(
      `| ${escaped} | ${escaped} | ${escaped} | ${escaped} | ${escaped}<br>일부 월드에서는 쓸 수 없음: ${escaped} | ${escaped} |\n`,
    );
  });

  it('accepts own enumerable prototype-shaped label names parsed from JSON', () => {
    const input = withCommand(4, { inputFields: ['__proto__', 'constructor', 'toString'] });
    const fieldLabels = JSON.parse(
      '{"amount":"수량","cityKey":"도시","__proto__":"원형","constructor":"생성자","toString":"문자열"}',
    ) as Record<string, string>;
    expect(renderCommandCatalog({ ...input, fieldLabels })).toBe(
      expectedDocument.replace(
        '| 이동 | 도시로 이동한다 | 도시 |',
        '| 이동 | 도시로 이동한다 | 원형, 생성자, 문자열 |',
      ),
    );
  });

  it.each(['__proto__', 'constructor', 'toString', ''])(
    'accepts identifier %j without prototype lookup or added syntax restrictions',
    (id) => {
      const input = fixture();
      const result = renderCommandCatalog({
        ...input,
        categories: input.categories.map((category) => (category.id === 'domestic' ? { ...category, id } : category)),
        commands: withCommand(3, { category: id, key: id }, input).commands,
      });
      expect(result).toBe(expectedDocument);
    },
  );
});

describe('renderCommandCatalog validation contract', () => {
  it.each([
    {
      name: 'same-target duplicate key',
      input: () => withCommand(4, { key: 'recruit' }),
      expected: [{ code: 'DUPLICATE_KEY', path: 'commands[4].key' }],
    },
    {
      name: 'same-target duplicate name',
      input: () => withCommand(4, { name: '모병' }),
      expected: [{ code: 'DUPLICATE_NAME', path: 'commands[4].name' }],
    },
    {
      name: 'unknown category',
      input: () => withCommand(3, { category: 'tactics' }),
      expected: [{ code: 'UNKNOWN_CATEGORY', path: 'commands[3].category' }],
    },
    {
      name: 'duplicate category id',
      input: () => ({ ...fixture(), categories: [...fixture().categories, { id: 'domestic', heading: '농업' }] }),
      expected: [{ code: 'DUPLICATE_CATEGORY', path: 'categories[5].id' }],
    },
    {
      name: 'unknown field',
      input: () => withCommand(4, { inputFields: ['crewType'] }),
      expected: [{ code: 'UNKNOWN_FIELD', path: 'commands[4].inputFields[0]' }],
    },
    {
      name: 'prototype fallback fields',
      input: () => withCommand(4, { inputFields: ['toString', '__proto__', 'constructor'] }),
      expected: [0, 1, 2].map((i) => ({ code: 'UNKNOWN_FIELD', path: `commands[4].inputFields[${i}]` })),
    },
    {
      name: 'unused blank heading',
      input: () => ({
        ...fixture(),
        commands: fixture().commands.slice(0, 5),
        categories: fixture().categories.map((c) => (c.id === 'strategy' ? { ...c, heading: '  ' } : c)),
      }),
      expected: [{ code: 'EMPTY_TEXT', path: 'categories[2].heading' }],
    },
    {
      name: 'unused label line break',
      input: () => ({ ...fixture(), fieldLabels: { ...fixture().fieldLabels, crewType: '병\n종' } }),
      expected: [{ code: 'LINE_BREAK', path: 'fieldLabels["crewType"]' }],
    },
    {
      name: 'quoted label path',
      input: () => ({ ...fixture(), fieldLabels: { ...fixture().fieldLabels, ['a.b"[0]']: '' } }),
      expected: [{ code: 'EMPTY_TEXT', path: 'fieldLabels["a.b\\"[0]"]' }],
    },
    {
      name: 'empty catalog still validates labels',
      input: () => ({ ...fixture(), commands: [], fieldLabels: { amount: '' } }),
      expected: [{ code: 'EMPTY_TEXT', path: 'fieldLabels["amount"]' }],
    },
    {
      name: 'name text errors precede duplicate name',
      input: () => withCommand(5, { name: '\n' }, withCommand(4, { name: '\n' })),
      expected: [
        { code: 'EMPTY_TEXT', path: 'commands[4].name' },
        { code: 'LINE_BREAK', path: 'commands[4].name' },
        { code: 'EMPTY_TEXT', path: 'commands[5].name' },
        { code: 'LINE_BREAK', path: 'commands[5].name' },
        { code: 'DUPLICATE_NAME', path: 'commands[5].name' },
      ],
    },
    {
      name: 'all layers preserve their issue order',
      input: () => {
        const input = withCommand(4, { key: 'recruit' }, withCommand(0, { summary: '' }));
        return {
          ...input,
          categories: [...input.categories, { id: 'domestic', heading: '' }],
          fieldLabels: { ...input.fieldLabels, crewType: ' ' },
        };
      },
      expected: [
        { code: 'DUPLICATE_CATEGORY', path: 'categories[5].id' },
        { code: 'EMPTY_TEXT', path: 'categories[5].heading' },
        { code: 'EMPTY_TEXT', path: 'fieldLabels["crewType"]' },
        { code: 'EMPTY_TEXT', path: 'commands[0].summary' },
        { code: 'DUPLICATE_KEY', path: 'commands[4].key' },
      ],
    },
  ])('$name', ({ input, expected }) => {
    expect(issuesFor(input())).toEqual(expected);
  });

  const displayCases: { path: string; input: (value: string) => CatalogInput }[] = [
    {
      path: 'categories[0].heading',
      input: (value) => ({
        ...fixture(),
        categories: fixture().categories.map((c, i) => (i === 0 ? { ...c, heading: value } : c)),
      }),
    },
    {
      path: 'fieldLabels["amount"]',
      input: (value) => ({ ...fixture(), fieldLabels: { amount: value, cityKey: '도시' } }),
    },
    { path: 'commands[0].name', input: (value) => withCommand(0, { name: value }) },
    { path: 'commands[0].summary', input: (value) => withCommand(0, { summary: value }) },
    { path: 'commands[2].requires[0]', input: (value) => withCommand(2, { requires: [value, '두 번째 조건'] }) },
    { path: 'commands[2].cost', input: (value) => withCommand(2, { cost: value }) },
    { path: 'commands[2].unavailableIn[1]', input: (value) => withCommand(2, { unavailableIn: ['작은 월드', value] }) },
  ];
  describe.each(displayCases)('$path', ({ path, input }) => {
    it.each(['', '  '])('rejects blank display text %j', (value) => {
      expect(issuesFor(input(value))).toEqual([{ code: 'EMPTY_TEXT', path }]);
    });
    it.each(['a\nb', 'a\rb'])('rejects line break %j', (value) => {
      expect(issuesFor(input(value))).toEqual([{ code: 'LINE_BREAK', path }]);
    });
    it.each(['\n', '\r\n'])('reports both text problems in order for %j', (value) => {
      expect(issuesFor(input(value))).toEqual([
        { code: 'EMPTY_TEXT', path },
        { code: 'LINE_BREAK', path },
      ]);
    });
  });

  it('validates labels in Object.keys order without sorting non-integer keys', () => {
    const input = { ...fixture(), commands: [], fieldLabels: { z: '', '10': '\n', '2': '', a: 'x\ry' } };
    expect(issuesFor(input)).toEqual([
      { code: 'EMPTY_TEXT', path: 'fieldLabels["2"]' },
      { code: 'EMPTY_TEXT', path: 'fieldLabels["10"]' },
      { code: 'LINE_BREAK', path: 'fieldLabels["10"]' },
      { code: 'EMPTY_TEXT', path: 'fieldLabels["z"]' },
      { code: 'LINE_BREAK', path: 'fieldLabels["a"]' },
    ]);
  });

  it('excludes inherited, non-enumerable and symbol labels from both lookup and validation', () => {
    const fieldLabels = Object.assign(
      Object.create({ inherited: '' }) as Record<string, string>,
      fixture().fieldLabels,
    );
    Object.defineProperty(fieldLabels, 'hidden', { value: '', enumerable: false });
    Object.defineProperty(fieldLabels, Symbol('symbol'), { value: '' });
    expect(renderCommandCatalog({ ...fixture(), fieldLabels })).toBe(expectedDocument);
    expect(issuesFor({ ...withCommand(4, { inputFields: ['inherited', 'hidden'] }), fieldLabels })).toEqual([
      { code: 'UNKNOWN_FIELD', path: 'commands[4].inputFields[0]' },
      { code: 'UNKNOWN_FIELD', path: 'commands[4].inputFields[1]' },
    ]);
  });

  it('reports every field in contract order, including repeated duplicate occurrences', () => {
    const input = withCommand(
      4,
      {
        key: 'recruit',
        category: 'unknown',
        name: '\n',
        summary: '',
        inputFields: ['missing'],
        requires: [''],
        cost: '\r',
        unavailableIn: [''],
      },
      withCommand(3, { key: 'recruit', name: '\n' }),
    );
    expect(issuesFor(input)).toEqual([
      { code: 'DUPLICATE_KEY', path: 'commands[3].key' },
      { code: 'EMPTY_TEXT', path: 'commands[3].name' },
      { code: 'LINE_BREAK', path: 'commands[3].name' },
      { code: 'DUPLICATE_KEY', path: 'commands[4].key' },
      { code: 'UNKNOWN_CATEGORY', path: 'commands[4].category' },
      { code: 'EMPTY_TEXT', path: 'commands[4].name' },
      { code: 'LINE_BREAK', path: 'commands[4].name' },
      { code: 'DUPLICATE_NAME', path: 'commands[4].name' },
      { code: 'EMPTY_TEXT', path: 'commands[4].summary' },
      { code: 'UNKNOWN_FIELD', path: 'commands[4].inputFields[0]' },
      { code: 'EMPTY_TEXT', path: 'commands[4].requires[0]' },
      { code: 'EMPTY_TEXT', path: 'commands[4].cost' },
      { code: 'LINE_BREAK', path: 'commands[4].cost' },
      { code: 'EMPTY_TEXT', path: 'commands[4].unavailableIn[0]' },
    ]);
  });
});
