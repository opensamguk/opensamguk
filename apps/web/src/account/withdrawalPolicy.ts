import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';

type CurrentPolicy = inferRouterOutputs<AppRouter>['legal']['current'];
// 같은 판 변경은 서버가 거부한다. 화면의 확인도 판·시행일·본문 모두에 묶는다.
export function privacyStamp(policy: CurrentPolicy): string | null {
  return policy.status === 'current' && policy.privacy.bodyText?.trim()
    ? JSON.stringify([policy.privacy.version, policy.privacy.effectiveAt, policy.privacy.bodyText])
    : null;
}
