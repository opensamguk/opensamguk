import { expect, type Page } from '@playwright/test';

// 로비 맨 위 공지 띠(LobbyPage NoticeBanner)는 가장 최근 공지 제목만 보이고, 누르면 공지판(NoticeBoard)을 펼친다.
// 공지판은 첫 공지만 펼쳐 두고 한 번에 하나만 연다. 띠가 접혀 있으면 공지판 전체가 숨어 있으므로 먼저 띠를 연다.
export function noticeBanner(page: Page) {
  return page.getByRole('button').filter({ hasText: /(목록 \d+|접기)$/ });
}

export async function openNoticeBoard(page: Page) {
  const banner = noticeBanner(page);
  if ((await banner.getAttribute('aria-expanded')) !== 'true') await banner.click();
  await expect(banner).toHaveAttribute('aria-expanded', 'true');
  const board = page.getByRole('region', { name: '공지', exact: true });
  await expect(board).toBeVisible();
  return board;
}

// 공지판을 열고 그 제목의 공지를 펼친다.
export async function openLobbyNotice(page: Page, title: string) {
  const board = await openNoticeBoard(page);
  const head = board
    .getByRole('listitem')
    .filter({ has: page.getByText(title, { exact: true }) })
    .getByRole('button');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
}
