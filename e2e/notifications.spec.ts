import { expect, test, type Page } from '@playwright/test';
import { createAccount } from './account';
import { ApiError, query } from './game';

// T2-21 · AC-M2-18 (화면): 실제 서버로 알림 설정 화면을 본다. 실제 디스코드로는 아무것도 보내지 않는다.
// T2-20(Codex)의 notification 라우터가 main에 없으면 파일 전체를 건너뛴다. 건너뛴 결과는 증거가 아니다.
// 등록이 성공하는 시험은 T2-20의 시험 전용 전송부와 localhost 가짜 수신기가 서버에 붙어 있어야 한다.
// 그 설정을 켠 실행에서만 E2E_FAKE_WEBHOOK=1을 주고 돌린다. 변수 이름은 T2-20 구현에 맞춰 바꾼다.

// 주소 검사를 통과하는 모양의 가짜 주소(가짜 ID·토큰).
const TOKEN = 'e2e-fake-token_0123456789abcdefWX34';
const FAKE_URL = `https://discord.com/api/webhooks/100000000000000001/${TOKEN}`;

async function apiReady(page: Page): Promise<boolean> {
  try {
    await query(page, 'notification.get');
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND' && error.status === 404) return false;
    throw error;
  }
}

async function open(page: Page) {
  await createAccount(page);
  test.skip(!(await apiReady(page)), 'T2-20 알림 API가 아직 main에 없다');
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { level: 1, name: '알림 설정' })).toBeVisible();
}

function watchConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message) => lines.push(message.text()));
  page.on('pageerror', (error) => lines.push(error.message));
  return lines;
}

test('디스코드가 아닌 주소는 고정 문장으로 거절되고 주소가 화면과 콘솔에 남지 않는다', async ({ page }) => {
  const consoleLines = watchConsole(page);
  await open(page);
  const notDiscord = `https://example.com/api/webhooks/1/${TOKEN}`;
  await page.getByRole('textbox', { name: '웹훅 주소' }).fill(notDiscord);
  await page.getByRole('button', { name: '시험 보내고 저장' }).click();
  await expect(page.getByRole('alert')).toHaveText('디스코드 웹훅 주소가 아닙니다.');
  await expect(page.getByRole('textbox', { name: '웹훅 주소' })).toHaveValue('');
  await expect(page.getByText('등록한 웹훅이 없습니다.')).toBeVisible();
  expect(await page.content()).not.toContain(TOKEN);
  expect(consoleLines.join('\n')).not.toContain(TOKEN);
});

test.describe('가짜 수신기로 등록', () => {
  test.skip(process.env.E2E_FAKE_WEBHOOK !== '1', 'T2-20 가짜 수신기 설정이 있는 실행에서만 돈다');

  test('등록, 종류 유지, 해제가 새로고침 뒤에도 남는다', async ({ page }) => {
    const consoleLines = watchConsole(page);
    await open(page);
    await page.getByRole('textbox', { name: '웹훅 주소' }).fill(FAKE_URL);
    await page.getByRole('button', { name: '시험 보내고 저장' }).click();
    await expect(page.getByTestId('webhook-registered')).toHaveText('등록됨 (…WX34)');
    expect(await page.content()).not.toContain(TOKEN);
    await page.screenshot({ path: test.info().outputPath('registered.png') });

    const attacked = page.getByRole('checkbox', { name: /^공격받음/ });
    await attacked.uncheck();
    await expect(page.getByText('저장 중')).toHaveCount(0);
    await page.reload();
    await expect(attacked).not.toBeChecked();

    await page.getByRole('button', { name: '해제' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '해제' }).click();
    await expect(page.getByText('등록한 웹훅이 없습니다.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('등록한 웹훅이 없습니다.')).toBeVisible();
    expect(consoleLines.join('\n')).not.toContain(TOKEN);
  });
});
