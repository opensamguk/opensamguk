import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/uptime.yml', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;
type Step = { uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if: string; 'runs-on': string; 'timeout-minutes': number; permissions: unknown; steps: Step[] };
const monitor = (workflow.jobs as Record<string, Job>).monitor!;

it('공개 확인은 main의 예약·수동만 받고 prod 실행을 취소하지 않는다', () => {
  expect((workflow.on as Record<string, unknown>).schedule).toEqual([{ cron: '7,17,27,37,47,57 * * * *' }]);
  const dispatch = (workflow.on as Record<string, { inputs: Record<string, unknown> }>).workflow_dispatch!;
  expect(Object.keys(dispatch.inputs)).toEqual(['drill_key', 'drill_status']);
  for (const value of Object.values(dispatch.inputs))
    expect(value).toMatchObject({ required: false, type: 'string', default: '' });
  expect(monitor.if).toBe("github.ref == 'refs/heads/main'");
  expect(monitor['runs-on']).toBe('ubuntu-24.04');
  expect(monitor['timeout-minutes']).toBe(10);
  expect(workflow.concurrency).toEqual({
    group: "${{ (inputs.drill_key != '' || inputs.drill_status != '') && 'uptime-drill' || 'uptime-prod' }}",
    'cancel-in-progress': false,
  });
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

it('운영과 연습 단계를 분리하고 연습에는 운영 주소·웹훅을 전달하지 않는다', () => {
  const prod = monitor.steps.at(-2)!,
    drill = monitor.steps.at(-1)!;
  expect(prod.if).toBe("inputs.drill_key == '' && inputs.drill_status == ''");
  expect(drill.if).toBe("inputs.drill_key != '' || inputs.drill_status != ''");
  expect(prod.run).toBe('node --import tsx tools/monitor/uptime.ts');
  expect(drill.run).toBe('node --import tsx tools/monitor/uptimeDrill.ts');
  expect(prod.env).toEqual({
    PUBLIC_URL: '${{ vars.PUBLIC_URL }}',
    UPTIME_STATE_REF: 'refs/heads/ops/uptime-state',
    UPTIME_GIT_REMOTE: 'https://github.com/${{ github.repository }}.git',
    UPTIME_KEY: 'prod',
    UPTIME_GIT_TOKEN: '${{ github.token }}',
    OPS_DISCORD_WEBHOOK: '${{ secrets.OPS_DISCORD_WEBHOOK }}',
  });
  expect(drill.env).toEqual({
    UPTIME_STATE_REF: 'refs/heads/ops/uptime-state',
    UPTIME_GIT_REMOTE: 'https://github.com/${{ github.repository }}.git',
    UPTIME_GIT_TOKEN: '${{ github.token }}',
    DRILL_KEY: '${{ inputs.drill_key }}',
    DRILL_STATUS: '${{ inputs.drill_status }}',
  });
  for (const step of monitor.steps.slice(0, -2))
    expect(JSON.stringify(step)).not.toMatch(/UPTIME_GIT_TOKEN|OPS_DISCORD_WEBHOOK|github\.token|secrets\./);
  expect(monitor.steps.filter((step) => step.run === 'pnpm install --frozen-lockfile')).toHaveLength(1);
});
