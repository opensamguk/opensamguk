import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { checkRuleFeatures } from '@opensamguk/rules';
import { loadInitialWorld, loadInitialWorldFromDb, loadPreset } from '../world/resources';
import { saveInitialWorld } from '../world/persistence';

async function main() {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      scenario: { type: 'string' },
      map: { type: 'string' },
      seed: { type: 'string' },
      'rule-features': { type: 'string' },
      'stat-rules': { type: 'string' },
      'portrait-map': { type: 'string' },
      published: { type: 'boolean' },
      'turn-term': { type: 'string' },
      'end-year': { type: 'string' },
      name: { type: 'string' },
      treaty: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm world:create [--preset <key>] [--published] [--stat-rules <key>] [--portrait-map <key>] [--rule-features a,b] [--scenario 1030 --map che --turn-term <분>] --seed <문자열> --end-year <연도> --name <이름> [--treaty]',
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
  const db = createDb(databaseUrl);
  try {
    const selection = {
      scenario,
      map,
      seed,
      ...(preset ? { unitSet: preset.unitSet } : {}),
      ...(values['stat-rules'] !== undefined ? { statRules: values['stat-rules'] } : {}),
      ...(values['portrait-map'] !== undefined ? { portraitMap: values['portrait-map'] } : {}),
    };
    const state = values.published ? await loadInitialWorldFromDb(db, selection) : await loadInitialWorld(selection);
    let ruleFeatures: string[] | undefined;
    if (values['rule-features'] !== undefined) {
      const requested = values['rule-features'].split(',');
      if (new Set(requested).size !== requested.length) throw new Error('규칙 기능이 중복됩니다.');
      ruleFeatures = checkRuleFeatures([...new Set([...(state.ruleFeatures ?? []), ...requested])]);
      if (state.ruleFeatures) state.ruleFeatures = ruleFeatures;
    }
    console.log(
      JSON.stringify(
        await saveInitialWorld(db, state, {
          ...(ruleFeatures !== undefined ? { ruleFeatures } : {}),
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
