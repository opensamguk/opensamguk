export interface CatalogCategory {
  id: string;
  heading: string;
}

export interface CatalogCommand {
  target: 'general' | 'nation';
  key: string;
  category: string;
  name: string;
  summary: string;
  inputFields: readonly string[];
  requires: readonly string[];
  cost: string | null;
  unavailableIn: readonly string[];
}

export interface CatalogInput {
  categories: readonly CatalogCategory[];
  fieldLabels: Readonly<Record<string, string>>;
  commands: readonly CatalogCommand[];
}

export interface CatalogIssue {
  code:
    | 'DUPLICATE_KEY'
    | 'DUPLICATE_NAME'
    | 'UNKNOWN_CATEGORY'
    | 'DUPLICATE_CATEGORY'
    | 'UNKNOWN_FIELD'
    | 'EMPTY_TEXT'
    | 'LINE_BREAK';
  path: string;
}

export class CommandCatalogError extends Error {
  readonly issues: readonly CatalogIssue[];

  constructor(issues: readonly CatalogIssue[]) {
    super(`Invalid command catalog: ${issues.length} issues`);
    this.name = 'CommandCatalogError';
    this.issues = issues;
  }
}

function checkText(value: string, path: string, issues: CatalogIssue[]): void {
  if (value.trim() === '') issues.push({ code: 'EMPTY_TEXT', path });
  if (/[\r\n]/.test(value)) issues.push({ code: 'LINE_BREAK', path });
}

function checkDuplicate(
  value: string,
  seen: Set<string>,
  code: 'DUPLICATE_CATEGORY' | 'DUPLICATE_KEY' | 'DUPLICATE_NAME',
  path: string,
  issues: CatalogIssue[],
): void {
  if (seen.has(value)) issues.push({ code, path });
  seen.add(value);
}

function validate(input: CatalogInput, fieldLabels: ReadonlyMap<string, string>): void {
  const issues: CatalogIssue[] = [];
  const categoryIds = new Set<string>();
  input.categories.forEach((category, index) => {
    checkDuplicate(category.id, categoryIds, 'DUPLICATE_CATEGORY', `categories[${index}].id`, issues);
    checkText(category.heading, `categories[${index}].heading`, issues);
  });
  for (const [key, value] of fieldLabels) checkText(value, `fieldLabels[${JSON.stringify(key)}]`, issues);

  const seenByTarget = new Map<CatalogCommand['target'], { keys: Set<string>; names: Set<string> }>([
    ['general', { keys: new Set(), names: new Set() }],
    ['nation', { keys: new Set(), names: new Set() }],
  ]);
  input.commands.forEach((command, index) => {
    const path = `commands[${index}]`;
    const seen = seenByTarget.get(command.target)!;
    checkDuplicate(command.key, seen.keys, 'DUPLICATE_KEY', `${path}.key`, issues);
    if (!categoryIds.has(command.category)) issues.push({ code: 'UNKNOWN_CATEGORY', path: `${path}.category` });
    checkText(command.name, `${path}.name`, issues);
    checkDuplicate(command.name, seen.names, 'DUPLICATE_NAME', `${path}.name`, issues);
    checkText(command.summary, `${path}.summary`, issues);
    command.inputFields.forEach((field, fieldIndex) => {
      if (!fieldLabels.has(field)) issues.push({ code: 'UNKNOWN_FIELD', path: `${path}.inputFields[${fieldIndex}]` });
    });
    command.requires.forEach((value, itemIndex) => checkText(value, `${path}.requires[${itemIndex}]`, issues));
    if (command.cost !== null) checkText(command.cost, `${path}.cost`, issues);
    command.unavailableIn.forEach((value, itemIndex) =>
      checkText(value, `${path}.unavailableIn[${itemIndex}]`, issues),
    );
  });
  if (issues.length > 0) throw new CommandCatalogError(issues);
}

function escapeCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|');
}

function renderRow(command: CatalogCommand, heading: string, fieldLabels: ReadonlyMap<string, string>): string {
  const conditions = command.requires.map(escapeCell);
  if (command.unavailableIn.length > 0) {
    conditions.push(`일부 월드에서는 쓸 수 없음: ${command.unavailableIn.map(escapeCell).join(', ')}`);
  }
  const cells = [
    escapeCell(heading),
    escapeCell(command.name),
    escapeCell(command.summary),
    command.inputFields.length > 0
      ? command.inputFields.map((field) => escapeCell(fieldLabels.get(field)!)).join(', ')
      : '없음',
    conditions.length > 0 ? conditions.join('<br>') : '없음',
    command.cost === null ? '없음' : escapeCell(command.cost),
  ];
  return `| ${cells.join(' | ')} |`;
}

export function renderCommandCatalog(input: CatalogInput): string {
  const fieldLabels = new Map(Object.entries(input.fieldLabels));
  validate(input, fieldLabels);

  const blocks = ['<!-- 직접 수정 금지. 생성 명령: pnpm docs:generate -->', '# 명령 목록'];
  for (const target of ['general', 'nation'] as const) {
    const commands = input.commands.filter((command) => command.target === target);
    if (commands.length === 0) continue;
    const sections = [target === 'general' ? '## 장수 명령' : '## 국가 명령'];
    for (const category of input.categories) {
      const rows = commands.filter((command) => command.category === category.id);
      if (rows.length === 0) continue;
      sections.push(
        `### ${category.heading}\n\n` +
          '| 분류 | 화면 이름 | 한 줄 설명 | 대상·수량 입력 | 조건 | 비용 |\n' +
          '| --- | --- | --- | --- | --- | --- |\n' +
          rows.map((command) => renderRow(command, category.heading, fieldLabels)).join('\n'),
      );
    }
    blocks.push(sections.join('\n\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}
