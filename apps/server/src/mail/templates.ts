import type { AccountTokenPurpose } from '../auth/accountToken';
import type { MailMessage } from './transport';

export function accountMail(
  to: string,
  purpose: AccountTokenPurpose,
  publicOrigin: string,
  token: string,
): MailMessage {
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error('계정 메일 출처를 확인하세요.');
  }
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !['VERIFY_EMAIL', 'RESET_PASSWORD'].includes(purpose)
  ) {
    throw new Error('계정 메일 생성값을 확인하세요.');
  }
  const verify = purpose === 'VERIFY_EMAIL';
  const link = new URL(verify ? '/verify-email' : '/reset-password', origin);
  link.hash = 'token=' + token;
  const subject = verify ? '오픈삼국 이메일 인증' : '오픈삼국 비밀번호 재설정';
  const text = verify
    ? `아래 링크에서 이메일을 인증하세요. 링크는24시간 동안 한 번 사용할 수 있습니다.\n\n${link.href}\n\n요청하지 않았다면 이 메일을 무시하세요.`
    : `아래 링크에서 비밀번호를 새로 정하세요. 링크는30분 동안 한 번 사용할 수 있습니다.\n\n${link.href}\n\n요청하지 않았다면 이 메일을 무시하세요.`;
  return { to, subject, text };
}
