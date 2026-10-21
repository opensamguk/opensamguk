import { appendFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { loadInitialWorld } from '../../apps/engine/src/world/resources';
import { simulateGame } from '../../apps/engine/src/simulation';

async function main() {
  const { values } = parseArgs({ options: {
    seeds: { type: 'string', default: '10' },
    seed: { type: 'string' },
    scenario: { type: 'string', default: '1030' },
    'max-year': { type: 'string', default: '300' },
    convergence: { type: 'string', default: 'on' },
    output: { type: 'string' },
    repeat: { type: 'boolean', default: false },
  } });
  const count = Number(values.seeds);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000 || (values.seed !== undefined && values.seeds !== '10')) throw new Error('--seeds는 1~10000 정수이며 --seed와 함께 지정하지 않습니다.');
  if (!['on', 'off'].includes(values.convergence)) throw new Error('--convergence는 on 또는 off입니다.');
  console.error(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), scenario: values.scenario, map: 'che', maxYear: Number(values['max-year']), convergence: values.convergence }));
  const seeds = values.seed === undefined ? Array.from({ length: count }, (_, i) => String(i + 1)) : [values.seed];
  for (const seed of seeds) {
    const initial = await loadInitialWorld({ scenario: values.scenario, map: 'che', seed });
    const options = { maxYear: Number(values['max-year']), convergence: values.convergence === 'on' };
    const result = simulateGame(initial, options);
    const line = JSON.stringify(result);
    console.log(line);
    if (values.output) await appendFile(values.output, `${line}\n`);
    if (result.seconds > 900) throw new Error(`시드 ${seed}: 900초를 넘었습니다.`);
    if (values.repeat) {
      const repeated = simulateGame(initial, options);
      const repeatLine = JSON.stringify({ ...repeated, repeat: true });
      console.log(repeatLine);
      if (values.output) await appendFile(values.output, `${repeatLine}\n`);
      if (repeated.stateHash !== result.stateHash || repeated.turns !== result.turns || repeated.seconds > 900) throw new Error(`시드 ${seed}: 반복 실행 해시·턴 수·시간을 확인하세요.`);
    }
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
