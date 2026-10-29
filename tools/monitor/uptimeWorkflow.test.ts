import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/uptime.yml', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;
type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if: string; 'runs-on': string; 'timeout-minutes': number; permissions: unknown; steps: Step[] };
const monitor = (workflow.jobs as Record<string, Job>).monitor!;

it('공개 확인은 main의 예약·수동만 받고 prod 실행을 취소하지 않는다', () => {
  expect(workflow.on).toEqual({ schedule: [{ cron: '7,17,27,37,47,57 * * * *' }], workflow_dispatch: null });
  expect(monitor.if).toBe("github.ref == 'refs/heads/main'");
  expect(monitor['runs-on']).toBe('ubuntu-24.04');
  expect(monitor['timeout-minutes']).toBe(10);
  expect(workflow.concurrency).toEqual({ group: 'uptime-prod', 'cancel-in-progress': false });
});

it('쓰기 권한은 감시 job만 받고 checkout은 자격 정보를 남기지 않는다', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs as object)).toEqual(['monitor']);
  expect(monitor.permissions).toEqual({ contents: 'write' });
  expect(workflow).not.toHaveProperty('env');
  expect(monitor).not.toHaveProperty('env');
  expect(monitor.steps[0]!.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
  for (const step of monitor.steps) {
    if (step.uses) expect(step.uses).toMatch(/^[a-zA-Z0-9_/-]+@[a-f0-9]{40}$/);
    expect(step).not.toHaveProperty('continue-on-error');
    expect(step.run ?? '').not.toMatch(/\$\{\{(?:\s*(?:inputs|secrets|vars)\.)/);
  }
});

it('비밀·원격·키·상태 ref는 기존 CLI step 하나에만 고정한다', () => {
  const runner = monitor.steps.at(-1)!;
  expect(runner.run).toBe('node --import tsx tools/monitor/uptime.ts');
  expect(runner.env).toEqual({
    PUBLIC_URL: '${{ vars.PUBLIC_URL }}',
    UPTIME_STATE_REF: 'refs/heads/ops/uptime-state',
    UPTIME_GIT_REMOTE: 'https://github.com/${{ github.repository }}.git',
    UPTIME_KEY: 'prod',
    UPTIME_GIT_TOKEN: '${{ github.token }}',
    OPS_DISCORD_WEBHOOK: '${{ secrets.OPS_DISCORD_WEBHOOK }}',
  });
  for (const step of monitor.steps.slice(0, -1))
    expect(JSON.stringify(step)).not.toMatch(/UPTIME_GIT_TOKEN|OPS_DISCORD_WEBHOOK|github\.token|secrets\./);
  expect(monitor.steps.filter((step) => step.run === 'pnpm install --frozen-lockfile')).toHaveLength(1);
});
