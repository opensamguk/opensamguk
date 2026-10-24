import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { loadInitialWorld, loadPreset } from '../world/resources';
import { saveInitialWorld } from '../world/persistence';

async function main() {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      scenario: { type: 'string' },
      map: { type: 'string' },
      seed: { type: 'string' },
      'rule-features': { type: 'string' },
      'turn-term': { type: 'string' },
      'end-year': { type: 'string' },
      name: { type: 'string' },
      treaty: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm world:create [--preset <key>] [--rule-features a,b] [--scenario 1030 --map che --turn-term <분>] --seed <문자열> --end-year <연도> --name <이름> [--treaty]',
    );
    return;
  }
  const preset = values.preset !== undefined ? await loadPreset(values.preset) : null;
  const scenario = values.scenario ?? preset?.scenario;
  const map = values.map ?? preset?.map;
  const turnTermMinutes = values['turn-term'] === undefined ? preset?.turnTermMinutes : Number(values['turn-term']);
  const { seed, name } = values;
  if (!scenario || !map || !seed || !name || turnTermMinutes === undefined || !values['end-year'])
    throw new Error('scenario, map, seed, turn-term, end-year, name이 필요합니다.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  const state = await loadInitialWorld({ scenario, map, seed, ...(preset ? { unitSet: preset.unitSet } : {}) });
  const db = createDb(databaseUrl);
  try {
    console.log(
      JSON.stringify(
        await saveInitialWorld(db, state, {
          ...(values['rule-features'] !== undefined ? { ruleFeatures: values['rule-features'].split(',') } : {}),
          name,
          turnTermMinutes,
          ...(preset ? { preset: { key: values.preset!, value: preset } } : {}),
          ...(values.treaty ? { treatyFormat: 1 } : {}),
          endYear: Number(values['end-year']),
        }),
      ),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '월드 생성에 실패했습니다.');
  process.exitCode = 1;
});
