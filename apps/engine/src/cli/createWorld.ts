import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { loadInitialWorld } from '../world/resources';
import { saveInitialWorld } from '../world/persistence';

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      map: { type: 'string' },
      seed: { type: 'string' },
      'turn-term': { type: 'string' },
      'end-year': { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm world:create --scenario 1030 --map che --seed <문자열> --turn-term <분> --end-year <연도> --name <이름>',
    );
    return;
  }
  const { scenario, map, seed, name } = values;
  if (!scenario || !map || !seed || !name || !values['turn-term'] || !values['end-year'])
    throw new Error('scenario, map, seed, turn-term, end-year, name이 필요합니다.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL이 없습니다. .env.example을 .env로 복사하세요.');
  const state = await loadInitialWorld({ scenario, map, seed });
  const db = createDb(databaseUrl);
  try {
    console.log(
      JSON.stringify(
        await saveInitialWorld(db, state, {
          name,
          turnTermMinutes: Number(values['turn-term']),
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
