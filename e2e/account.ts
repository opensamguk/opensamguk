import { existsSync } from 'node:fs';
import { test, type Page } from '@playwright/test';
import type { PrismaClient } from '../packages/db/src/index';

// E2E 전용 테스트 계정. 실행마다 새 이메일을 써서 DB에 남은 계정과 부딪히지 않게 한다.
// 서버는 같은 IP의 가입을 1시간에 10번까지만 받는다 (T3-04). 화면으로 가입하는 시험 몇 개만 실제로 가입하고,
// 나머지 시험의 계정과 세션은 createAccount로 E2E 전용 DB에 바로 만든다.

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');

export const TEST_PASSWORD = 'e2e-password-0001';

export function newEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

// 화면이 열린 출처(playwright.config의 baseURL). 서버는 /trpc POST의 Origin이 PUBLIC_ORIGIN과 같아야 받는다.
// 개발 기본 PUBLIC_ORIGIN도 http://127.0.0.1:5173이다. page.request로 보내는 POST에는 이 값을 붙인다.
export function appOrigin(): string {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('playwright.config에 baseURL이 필요합니다.');
  return new URL(baseURL).origin;
}

// 시험이 DB를 직접 읽고 바꾸는 곳은 모두 이 주소를 쓴다. 이름이 _test로 끝나는 전용 DB가 아니면 멈춘다.
export function e2eDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL이 필요합니다.');
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.endsWith('_test'))
    throw new Error('E2E는 이름이 _test로 끝나는 전용 DB에서만 돌립니다. DATABASE_URL의 DB 이름을 확인하세요.');
  return url;
}

export async function withE2eDb<T>(work: (db: PrismaClient) => Promise<T>): Promise<T> {
  const { createDb } = await import('../packages/db/src/index');
  const db = createDb(e2eDatabaseUrl());
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

let passwordHash: Promise<string> | undefined;

// 계정과 세션을 DB에 바로 만들고 세션 쿠키를 브라우저에 넣는다. 가입 API를 거치지 않으므로 가입 한도를 쓰지 않는다.
// 비밀번호 해시와 세션 토큰은 서버의 auth 모듈로 만든다. 화면 로그인과 세션 확인은 실제 서버 경로를 그대로 탄다.
export async function createAccount(page: Page, email = newEmail()): Promise<string> {
  const [{ hashPassword }, { newSession }] = await Promise.all([
    import('../apps/server/src/auth/password'),
    import('../apps/server/src/auth/session'),
  ]);
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const hash = await passwordHash;
  const session = newSession(Date.now());
  await withE2eDb((db) =>
    db.user.create({
      data: { email, passwordHash: hash, sessions: { create: { id: session.id, expiresAt: session.expiresAt } } },
      select: { id: true },
    }),
  );
  await page
    .context()
    .addCookies([{ name: 'sid', value: session.token, url: appOrigin(), httpOnly: true, sameSite: 'Lax' }]);
  return email;
}
