import { buildServer } from '../apps/server/src/server';

// 운영 HTTP 고정물의 설정만 명시한다. 인증 설정 거부 시험은 실제 buildServer를 직접 호출한다.
export async function buildFixtureServer(options: Parameters<typeof buildServer>[0]) {
  if (!options.production) return buildServer(options);
  const previous = process.env.EMAIL_VERIFICATION_REQUIRED;
  process.env.EMAIL_VERIFICATION_REQUIRED = '1';
  try {
    return await buildServer(options);
  } finally {
    if (previous === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
    else process.env.EMAIL_VERIFICATION_REQUIRED = previous;
  }
}
