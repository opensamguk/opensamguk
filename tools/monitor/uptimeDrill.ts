import { appendFile } from 'node:fs/promises';
import { readUptimeDrillConfig, runUptimeDrill, UptimeDrillError } from './uptimeDrillRun';

try {
  if (process.argv.length !== 2) throw new UptimeDrillError('configuration');
  const { config, git } = readUptimeDrillConfig(process.env);
  const result = await runUptimeDrill(config, { git });
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      'Uptime drill\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n',
    );
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
} catch (error) {
  const kinds = (error instanceof AggregateError ? error.errors : [error]).map((value) =>
    value instanceof UptimeDrillError ? value.kind : 'internal',
  );
  process.stdout.write(JSON.stringify({ ok: false, kinds }) + '\n');
  process.exitCode = 1;
}
