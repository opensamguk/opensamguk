import { adminRole } from './adminSetup';
import { expect, test } from './t210-fixture';

test('운영 배포 화면은 호스트 승인본만 접수하고 같은 승인본의 중복 요청을 막는다', async ({ world }) => {
  const admin = await world.user('ruler');
  await adminRole(world, admin, 'grant');
  const { db } = world.hold;
  const current = 'a'.repeat(40);
  const revision = 'b'.repeat(40);
  const manifestSha256 = 'c'.repeat(64);
  const { page } = admin;
  await page.goto(world.stack.webOrigin + '/admin/releases');
  await expect(page.getByRole('heading', { name: '배포 관리' })).toBeVisible();
  await expect(page.getByText('배포 호스트에 연결되어 있지 않습니다.')).toBeVisible();
  await db.releaseControl.create({
    data: {
      id: 'production',
      currentRevision: current,
      candidates: [{ operation: 'DEPLOY', revision, manifestSha256 }],
      seenAt: new Date(),
    },
  });

  await page.reload();
  await expect(page.getByText(current, { exact: true })).toBeVisible();
  const approved = page.getByRole('button', { name: '배포 ' + revision.slice(0, 12) });
  await approved.click();
  await expect(page.getByRole('button', { name: '배포 요청' })).toBeDisabled();
  await page.getByLabel('실행 사유').fill('승인본 공개');
  await page.getByRole('button', { name: '배포 요청' }).click();
  await expect(page.getByRole('status')).toContainText('접수');
  await expect(approved).toBeDisabled();
  expect(await db.releaseRequest.findMany()).toEqual([
    expect.objectContaining({
      actorUserId: admin.userId,
      operation: 'DEPLOY',
      status: 'QUEUED',
      expectedRevision: current,
      targetRevision: revision,
      manifestSha256,
    }),
  ]);
});
