import { readUptimeConfig } from './uptimeConfig';
import { runUptime, UptimeRunError } from './uptimeRun';

try {
  if (process.argv.length !== 2) throw new UptimeRunError('configuration');
  const { config, token } = readUptimeConfig(process.env);
  const result = await runUptime(config, token === undefined ? {} : { git: { httpsToken: token } });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: error instanceof UptimeRunError ? error.kind : 'internal',
      warnings: error instanceof UptimeRunError ? error.warnings : [],
    }) + '\n',
  );
  process.exitCode = 1;
}
