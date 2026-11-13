import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { checkRuleFeatures } from '@opensamguk/rules';
import { composeInitialWorld, readInitialResources, loadPreset } from '../world/resources';
import { createWorldFromCli } from '../admin/creation';

async function main() {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      scenario: { type: 'string' },
      map: { type: 'string' },
      seed: { type: 'string' },
      'rule-features': { type: 'string' },
      'unit-set': { type: 'string' },
      'stat-rules': { type: 'string' },
      'portrait-map': { type: 'string' },
      published: { type: 'boolean' },
      'turn-term': { type: 'string' },
      'end-year': { type: 'string' },
      name: { type: 'string' },
      treaty: { type: 'boolean' },
      ext: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm world:create [--preset <key>] [--published] [--unit-set <key>] [--stat-rules <key>] [--portrait-map <key>] [--rule-features a,b] [--scenario 1030 --map che --turn-term <분>] --seed <문자열> --end-year <연도> --name <이름> [--treaty] [--ext]',
    );
    console.log('게시된 DB 자원을 사용합니다. --published는 이전 호출과의 호환을 위해 허용합니다.');
    return;
  }
  const preset = values.preset !== undefined ? await loadPreset(values.preset) : null;
  if (values.ext && (!preset?.commands || values.treaty || values['rule-features'] !== undefined))
    throw new Error('--ext는 확장 명령을 고른 프리셋으로만 쓰며 조약·규칙 기능 옵션과 함께 쓸 수 없습니다.');
  const scenario = values.scenario ?? preset?.scenario;
  const map = values.map ?? preset?.map;
  const turnTermMinutes = values['turn-term'] === undefined ? preset?.turnTermMinutes : Number(values['turn-term']);
  const { seed, name } = values;
  if (!scenario || !map || !seed || !name || turnTermMinutes === undefined || !values['end-year'])
    throw new Error('scenario, map, seed, turn-term, end-year, name이 필요합니다.');
  const selection = {
    scenario,
    map,
    seed,
    ...(values['unit-set'] !== undefined ? { unitSet: values['unit-set'] } : preset ? { unitSet: preset.unitSet } : {}),
    ...(values['stat-rules'] !== undefined ? { statRules: values['stat-rules'] } : {}),
    ...(values['portrait-map'] !== undefined ? { portraitMap: values['portrait-map'] } : {}),
  };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  const db = createDb(databaseUrl);
  try {
    const resources = await readInitialResources(db, selection);
    const state = composeInitialWorld(resources, seed);
    let ruleFeatures: string[] | undefined;
    const selectedFeatures = state.unitSet?.coefMode === 'multiply' ? ['battle-affinity-v2'] : [];
    if (values['rule-features'] !== undefined || selectedFeatures.length) {
      const requested = values['rule-features']?.split(',') ?? [];
      if (new Set(requested).size !== requested.length) throw new Error('규칙 기능이 중복됩니다.');
      ruleFeatures = checkRuleFeatures(
        [...new Set([...(state.ruleFeatures ?? []), ...selectedFeatures, ...requested])].sort(),
      );
      if (state.ruleFeatures) state.ruleFeatures = ruleFeatures;
    }
    console.log(
      JSON.stringify(
        await createWorldFromCli(
          db,
          state,
          {
            ...(ruleFeatures !== undefined ? { ruleFeatures } : {}),
            name,
            turnTermMinutes,
            ...(preset ? { preset: { key: values.preset!, value: preset } } : {}),
            ...(values.treaty ? { treatyFormat: 1 } : {}),
            ...(values.ext ? { extFormat: 1 } : {}),
            endYear: Number(values['end-year']),
          },
          resources,
        ),
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
