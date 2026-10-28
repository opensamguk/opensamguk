import { validateUptimeRunConfig, UptimeRunError, type UptimeRunConfig } from './uptimeRun';
import { validateUptimeToken } from './uptimeGitAuth';

export function readUptimeConfig(env: NodeJS.ProcessEnv) {
  const config: UptimeRunConfig = {
    stateRef: env.UPTIME_STATE_REF ?? '',
    publicUrl: env.PUBLIC_URL ?? '',
    remote: env.UPTIME_GIT_REMOTE ?? '',
    key: env.UPTIME_KEY ?? 'prod',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
    webhook: env.OPS_DISCORD_WEBHOOK ?? '',
  };
  const validated = validateUptimeRunConfig(config);
  if (validated.mode === 'disabled') return { config, token: undefined };
  const token = env.UPTIME_GIT_TOKEN;
  try {
    validateUptimeToken(token);
  } catch {
    throw new UptimeRunError('configuration');
  }
  return { config, token };
}
