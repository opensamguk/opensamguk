import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, type LegalStack } from './legalFixture';
import { sanctionAccount } from './adminSanctionSetup';
import { endFootprint } from './adminEndSetup';
import { initializeIntegrationResources } from '../tools/integration-resources';
import { ruleRegistry } from '../packages/rules/src/index';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { buildServer } from '../apps/server/src/server';
import { listenLegalLoopback } from './legalFixturePorts';

// 429 시간 창은 이 시험 서버의 주입 시계만 움직인다. 실제 HTTP·세션·접수는 그대로 쓴다.
export async function creationRateServer(stack: LegalStack) {
  let now = Date.now();
  const server = await buildServer({
    db: stack.db,
    publicOrigin: stack.origin,
    emailVerificationRequired: true,
    now: () => now,
    logging: false,
  });
  try {
    await listenLegalLoopback(
      (port) => server.listen({ host: '127.0.0.1', port }),
      () => server.server.listening,
    );
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('자기 시험 서버 주소를 확인하세요.');
    return {
      origin: `http://127.0.0.1:${address.port}`,
      advance: (milliseconds: number) => {
        now += milliseconds;
      },
      close: () => server.close(),
    };
  } catch {
    await server.close();
    throw new Error('자기 요청 제한 서버를 준비하지 못했습니다.');
  }
}

export async function createActor(page: Page, stack: LegalStack) {
  await stack.restart(null, true);
  await initializeIntegrationResources(stack.db);
  // 아직 통합하지 않은 규칙을 fixture나 mock으로 켜지 않는다.
  expect(ruleRegistry.features.some((feature) => feature.key === 'city-resources-v1')).toBe(true);
  return sanctionAccount(stack, page, true);
}
export async function prepareCreation(page: Page, stack: LegalStack, name = '새 개장 전 월드') {
  await page.goto(stack.origin + '/admin/worlds');
  const controls = page.getByRole('region', { name: '새 월드 생성', exact: true });
  await controls.getByRole('button', { name: '새 월드 생성 준비', exact: true }).click();
  await controls.getByLabel('시나리오', { exact: true }).selectOption('integration-v01');
  await controls.getByLabel('월드 이름', { exact: true }).fill(name);
  await controls.getByLabel('프리셋', { exact: true }).selectOption('regular');
  return controls;
}
export async function reviewCreationPage(page: Page) {
  await page.getByRole('button', { name: '현재 설정 검토', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '개장 전 월드 생성 확인', exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('checkbox', { name: '이름·현재 설정·시드와 개장 전 생성을 확인했습니다.', exact: true })
    .check();
  return dialog;
}
export async function submitCreation(page: Page) {
  const dialog = await reviewCreationPage(page);
  await dialog.getByRole('button', { name: '개장 전 월드 생성 요청', exact: true }).click();
  await expect(page.getByText('접수됨 · 생성 대기', { exact: true })).toBeVisible();
}
export async function createRequest(stack: LegalStack, userId: string) {
  return stack.db.worldCreateRequest.findFirstOrThrow({
    where: { requestedBy: userId },
    orderBy: { createdAt: 'desc' },
  });
}
export async function applyCreation(stack: LegalStack, userId: string) {
  const request = await createRequest(stack, userId);
  expect(request.status).toBe('PENDING');
  expect(await stack.db.worldCreateRequest.count({ where: { status: 'PENDING' } })).toBe(1);
  await processWorldCreateRequest(stack.db, AbortSignal.timeout(20_000));
  return stack.db.worldCreateRequest.findUniqueOrThrow({ where: { id: request.id } });
}
export async function createdResult(page: Page, result: { status: string; worldId: string | null }) {
  expect(result.status).toBe('DONE');
  expect(result.worldId).not.toBeNull();
  if (!(await page.getByText('생성 완료 · 개장 전', { exact: true }).isVisible())) {
    try {
      await page.getByRole('button', { name: '요청 상태 확인', exact: true }).click();
    } catch (clickError) {
      const terminalVisible = await Promise.all([
        page.getByText('생성 완료 · 개장 전', { exact: true }).isVisible(),
        page
          .getByRole('status')
          .filter({ has: page.getByText('생성 완료 · 개장 전', { exact: true }) })
          .getByText(result.worldId!, { exact: true })
          .isVisible(),
      ]).then(
        (visibility) => visibility.every(Boolean),
        () => false,
      );
      if (!terminalVisible) throw clickError;
    }
  }
  await expect(page.getByText('생성 완료 · 개장 전', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ has: page.getByText('생성 완료 · 개장 전', { exact: true }) })
      .getByText(result.worldId!, { exact: true }),
  ).toBeVisible();
}
export async function creationSource(stack: LegalStack) {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'create-ui-preserved-' + randomUUID(),
  });
  initial.ruleFeatures = [
    'campaign-assignment-v2',
    'campaign-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
    'stratagem-basic',
    'treaty',
  ];
  const saved = await saveInitialWorld(stack.db, initial, {
    name: '보존할 기존 월드',
    turnTermMinutes: 60,
    endYear: 201,
  });
  return { id: saved.worldId, fingerprint: await endFootprint(stack, saved.worldId, true) };
}
export async function responsiveCreation(page: Page, label: string) {
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page.locator('main button, main input, main select, main a, dialog button, dialog input').evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
          }).length,
      ),
    ).toBe(0);
    if (width !== 768)
      await page.screenshot({ path: 'test-results/create-' + label + '-' + width + '.png', fullPage: true });
  }
}
