import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { validateBundle } from './validate';
import { probeHttp } from './http';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: { type: 'string' },
      'source-sha': { type: 'string' },
      'base-url': { type: 'string' },
      fixture: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1 || !values['source-sha']) throw new Error('USAGE');
  if (positionals[0] === 'validate' && values.manifest && !values['base-url']) {
    const report = await validateBundle(resolve(values.manifest), values['source-sha']);
    console.log(JSON.stringify(report));
    // Explicit fixture mode only proves tooling. It can never override an invalid bundle.
    const fixtureOnly =
      values.fixture && report.notReadyReasons.length === 1 && report.notReadyReasons[0] === 'SYNTHETIC_TOOL_TEST_ONLY';
    process.exitCode = report.toolStatus === 'VALID' && fixtureOnly ? 0 : 1;
  } else if (positionals[0] === 'probe' && values['base-url'] && !values.manifest && !values.fixture) {
    const report = await probeHttp(values['base-url'], values['source-sha']);
    console.log(JSON.stringify(report));
    process.exitCode = report.toolStatus === 'VALID' ? 0 : 1;
  } else throw new Error('USAGE');
}
main().catch(() => {
  console.log(
    JSON.stringify({
      version: 1,
      toolStatus: 'INVALID',
      productStatus: 'NOT_READY',
      acStatus: 'NOT_ASSESSED',
      issues: ['INVALID_ARGUMENTS_OR_PROBE_FAILED'],
    }),
  );
  process.exitCode = 2;
});
