import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

export type CurrentPolicy = inferRouterOutputs<AppRouter>['legal']['current'];
export const consentDocuments = ['TERMS', 'PRIVACY'] as const;
export type ConsentDocument = (typeof consentDocuments)[number];
export const documentTitles = { TERMS: '이용약관', PRIVACY: '개인정보처리방침' } as const;
export const documentKeys = { TERMS: 'terms', PRIVACY: 'privacy' } as const;

// 체크는 판 번호뿐 아니라 사용자가 읽은 시행일·본문 쌍에도 묶인다.
export function readablePolicy(current: CurrentPolicy | undefined) {
  if (current?.status !== 'current' || !current.terms.bodyText?.trim() || !current.privacy.bodyText?.trim())
    return null;
  const terms = { ...current.terms, bodyText: current.terms.bodyText };
  const privacy = { ...current.privacy, bodyText: current.privacy.bodyText };
  return { terms, privacy, stamp: JSON.stringify({ terms, privacy }) };
}

export function signupPolicyStamp(current: CurrentPolicy | undefined): string | null {
  if (current?.status === 'pending' && !current.signupRequiresPolicy) return 'pending:optional';
  return readablePolicy(current)?.stamp ?? null;
}
