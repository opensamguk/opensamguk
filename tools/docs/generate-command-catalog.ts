import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  commands,
  COMMAND_CATEGORIES,
  extensionCommands,
  parsePreset,
  resolverForPreset,
  resolverForRuleFeatures,
  ruleRegistry,
  type CommandDef,
} from '../../packages/rules/src/index';
import { commandPlayerDocs } from '../../packages/rules/src/commands/playerDoc';
import { renderCommandCatalog } from './command-catalog';

const presetDir = new URL('../../resources/preset/', import.meta.url);
const catalogFile = new URL('../../docs/user/command-catalog.generated.md', import.meta.url);
const headings = { domestic: '내정', military: '군사', strategy: '전략', personal: '개인', nation: '국가' };
const fieldLabels = {
  cityKey: '대상 도시',
  nationId: '대상 국가',
  generalId: '대상 장수',
  amount: '수량',
  crewType: '병종',
  buy: '사고팔기',
  resource: '자원',
  name: '나라 이름',
  color: '나라 색',
  unitId: '대상 부곡',
  target: '훈련 대상',
  slot: '장비 칸',
  itemKey: '장비 종류',
};

function inputFields(schema: z.core.JSONSchema.JSONSchema): string[] {
  const fields = Object.entries(schema.properties ?? {})
    .filter(([, field]) => field !== false && (field === true || !Object.hasOwn(field, 'not')))
    .map(([field]) => field);
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  return [...fields, ...branches.flatMap(inputFields)];
}

function featureCommands(): CommandDef[] {
  const features = new Map(ruleRegistry.features.map((feature) => [feature.key, feature]));
  return ruleRegistry.features.flatMap(({ key }) => {
    const selected = new Set([key]);
    for (const dependency of selected) {
      const feature = features.get(dependency);
      if (!feature) throw new Error(`등록부에 없는 선행 기능입니다: ${dependency}`);
      for (const required of feature.requires) selected.add(required);
    }
    const resolver = resolverForRuleFeatures({ ruleFeatures: [...selected].sort() });
    return resolver ? [...resolver.list('general'), ...resolver.list('nation')] : [];
  });
}

export async function generateCommandCatalog(): Promise<Buffer> {
  const files = (await readdir(presetDir)).filter((file) => file.endsWith('.json')).sort();
  const presets = await Promise.all(
    files.map(async (file) => {
      const preset = parsePreset(JSON.parse(await readFile(new URL(file, presetDir), 'utf8')));
      return { name: preset.name, resolver: resolverForPreset(preset) };
    }),
  );
  const definitions = new Map<string, CommandDef>();
  const fields = new Map<string, Set<string>>();
  const presetKeys = new Set(extensionCommands.map(({ key }) => key));
  const baseDefinitions = [...commands, ...extensionCommands];
  if (new Set(baseDefinitions.map(({ key }) => key)).size !== baseDefinitions.length)
    throw new Error('명령 등록부에 중복 키가 있습니다.');
  for (const definition of [...baseDefinitions, ...featureCommands()]) {
    const { key, name, target, category, args } = definition;
    const known = definitions.get(key);
    if (known && (known.name !== name || known.target !== target || known.category !== category))
      throw new Error(`명령의 이름·분류·대상이 기능에 따라 달라집니다: ${key}`);
    if (!known) definitions.set(key, definition);
    const accepted = fields.get(key) ?? new Set<string>();
    for (const field of inputFields(z.toJSONSchema(args, { io: 'input' }))) accepted.add(field);
    fields.set(key, accepted);
  }
  for (const key of Object.keys(commandPlayerDocs)) {
    if (!definitions.has(key)) throw new Error(`명령 등록부에 없는 도움말입니다: ${key}`);
  }
  const markdown = renderCommandCatalog({
    categories: COMMAND_CATEGORIES.map((id) => ({ id, heading: headings[id] })),
    fieldLabels,
    commands: [...definitions.values()].map(({ target, key, category, name }) => {
      const doc = commandPlayerDocs[key];
      if (!Object.hasOwn(commandPlayerDocs, key) || !doc) throw new Error(`명령 도움말이 없습니다: ${key}`);
      return {
        target,
        key,
        category,
        name,
        ...doc,
        inputFields: [...fields.get(key)!],
        unavailableIn: presetKeys.has(key)
          ? presets.filter(({ resolver }) => !resolver.get(key)).map(({ name }) => name)
          : [],
      };
    }),
  });
  return Buffer.from(markdown, 'utf8');
}

export async function checkCommandCatalog(path: URL = catalogFile): Promise<void> {
  const expected = await generateCommandCatalog();
  const stored = await readFile(path).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stored?.equals(expected)) throw new Error('명령 목록이 오래됐습니다. pnpm docs:generate를 실행하세요.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) await writeFile(catalogFile, await generateCommandCatalog());
  else if (args.length === 1 && args[0] === '--check') await checkCommandCatalog();
  else throw new Error('사용법: pnpm docs:generate [--check]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
