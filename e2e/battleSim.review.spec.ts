import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { simulateBattle, unitSetSchema } from '../packages/rules/src/index';
import { createRng } from '../packages/shared/src/index';
import { createAccount } from './account';
import { e2eWorld } from './game';
import { bindGeneral, query } from './world';

const unitSet = unitSetSchema.parse(JSON.parse(readFileSync('resources/unitset/basic.json', 'utf8')));
const policy = readFileSync('deploy/security.caddy', 'utf8').match(/Content-Security-Policy "([^"]+)"/)![1]!;

test('independent production CSP, real Worker 480 differential cases, seed and narrow screenshot', async ({ page }) => {
  test.setTimeout(90_000);
  await createAccount(page);
  const world = await e2eWorld(page);
  const { user } = await query<{ user: { id: string } }>(page.request, 'auth.me');
  await bindGeneral(world, user.id);
  console.log('production fixture ready');
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { violations: string[] }).violations.push(event.violatedDirective + ':' + event.blockedURI);
    });
  });
  const response = await page.goto(`/w/${world}/simulator`);
  expect(response!.headers()['content-security-policy']).toBe(policy);
  await expect(page.getByRole('heading', { name: '전투 시뮬레이터', level: 1 })).toBeVisible();
  const workerPromise = page.waitForEvent('worker');
  await page.getByRole('button', { name: '실행', exact: true }).click();
  const uiWorker = await workerPromise;
  await expect(page.getByTestId('battle-result')).toHaveAttribute('data-state', 'done');
  const workerUrl = uiWorker.url();
  expect(new URL(workerUrl).origin).toBe('http://127.0.0.1:5173');
  expect(workerUrl).toMatch(/\/assets\/battle\.worker-.*\.js$/);
  console.log('production UI Worker ready', workerUrl);
  await page.screenshot({ path: test.info().outputPath('production-csp-result.png'), fullPage: true });
  const first = await page.getByTestId('battle-result').innerText();
  await page.getByRole('button', { name: '같은 값으로 다시 실행' }).click();
  await expect(page.getByTestId('battle-result')).toHaveAttribute('data-state', 'done');
  expect(await page.getByTestId('battle-result').innerText()).toBe(first);

  const requests = Array.from({ length: 240 }, (_, i) =>
    [false, true].map((wall) => ({
      type: 'run',
      requestId: i * 2 + (wall ? 2 : 1),
      seed: ` independent-${i}-가 `,
      attacker: {
        crew: 1 + ((i * 37) % 10000),
        crewType: [1100, 1200, 1300][i % 3]!,
        train: (i * 7) % 101,
        atmos: (i * 11) % 101,
      },
      defender: {
        crew: 1 + ((i * 53) % (wall ? 12500 : 10000)),
        crewType: wall ? 1000 : [1300, 1100, 1200][i % 3]!,
        train: wall ? 100 : (i * 13) % 101,
        atmos: wall ? 100 : (i * 17) % 101,
      },
      attackerTech: (i * 97) % 12001,
      defenderTech: (i * 59) % 12001,
      ...(wall ? { defence: (i * 71) % 12501 } : {}),
    })),
  ).flat();
  const replies = await page.evaluate(
    async ({ url, messages }) => {
      const worker = new Worker(url, { type: 'module' });
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const result: unknown[] = [];
          worker.onerror = () => reject(new Error('real production worker failed'));
          worker.onmessage = (e) => {
            result.push(e.data);
            if (result.length === messages.length) resolve(result);
          };
          messages.forEach((message) => worker.postMessage(message));
        });
      } finally {
        worker.terminate();
      }
    },
    { url: workerUrl, messages: requests },
  );
  expect(replies).toHaveLength(480);
  console.log('production differential replies', replies.length);
  requests.forEach(({ type: _type, requestId, seed, ...input }, index) => {
    expect(_type).toBe('run');
    const expected = simulateBattle({ ...input, unitSet }, createRng(seed));
    expect(replies[index]).toEqual({
      type: 'result',
      requestId,
      seed,
      input,
      unitSetId: 'basic',
      attacker: expected.attacker,
      defender: expected.defender,
    });
  });

  const invalid = [
    { ...requests[0], requestId: 501, attackerTech: Number.POSITIVE_INFINITY },
    { ...requests[0], requestId: 502, seed: '' },
    { ...requests[0], requestId: 503, unitSet: {} },
    { ...requests[0], requestId: 504, attacker: { ...requests[0]!.attacker, crew: Number.NaN } },
  ];
  const rejected = await page.evaluate(
    async ({ url, messages }) => {
      const worker = new Worker(url, { type: 'module' });
      try {
        return await new Promise<unknown[]>((resolve) => {
          const result: unknown[] = [];
          worker.onmessage = (e) => {
            result.push(e.data);
            if (result.length === messages.length) resolve(result);
          };
          messages.forEach((message) => worker.postMessage(message));
        });
      } finally {
        worker.terminate();
      }
    },
    { url: workerUrl, messages: invalid },
  );
  for (const reply of rejected) expect(reply).toMatchObject({ type: 'error', code: 'INVALID_INPUT' });
  console.log('production invalid replies', rejected.length);

  await page.setViewportSize({ width: 375, height: 800 });
  const section = page.getByRole('region', { name: '전투 시뮬레이터', exact: true });
  const dimensions = await section.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(dimensions.right).toBeLessThanOrEqual(375);
  await page.screenshot({ path: test.info().outputPath('production-csp-narrow.png'), fullPage: true });
  violations.push(...(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)));
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
  writeFileSync(
    test.info().outputPath('production-evidence.json'),
    JSON.stringify(
      {
        productSha: '4a99437b950ea73007e05c84863a6e0be7f6fcd2',
        workerUrl,
        policy,
        differentialCases: replies.length,
        seeds: 240,
        invalidRejected: rejected.length,
        dimensions,
        violations,
        errors,
      },
      null,
      2,
    ),
  );
  // The existing topbar's 375px layout belongs to T3-10, not the simulator.
  await page.setViewportSize({ width: 1280, height: 800 });
  const closed = new Promise<void>((resolve) => uiWorker.once('close', () => resolve()));
  await page.getByRole('navigation', { name: '게임 메뉴' }).getByRole('link', { name: '메인', exact: true }).click();
  await closed;
  console.log('production UI Worker closed');
});
