import { describe, expect, it } from 'vitest';
import { appRouter } from '../router';
import type { ProcedureMeta } from '../trpc';

const VERIFIED_MUTATIONS = [
  'admin.notice.create',
  'admin.notice.hide',
  'admin.notice.update',
  'admin.sanction.create',
  'admin.sanction.lift',
  'campaign.relationship',
  'campaign.unit',
  'general.create',
  'general.setPolicy',
  'message.markRead',
  'message.send',
  'nationTurns.edit',
  'nationTurns.set',
  'notice.nation.markSeen',
  'notice.nation.set',
  'offers.respond',
  'operation.close',
  'operation.create',
  'personnel.appoint',
  'personnel.dismiss',
  'treaty.break',
  'treaty.propose',
  'treaty.respond',
  'turns.edit',
  'turns.set',
] as const;
const RECOVERY_MUTATIONS = [
  'account.requestPasswordReset',
  'account.resendVerification',
  'account.resetPassword',
  'account.verifyEmail',
  'account.withdraw',
  'auth.login',
  'auth.logout',
  'auth.signup',
  'legal.agree',
];

describe('T3-02 AC-M3-01 이메일 인증 경계', () => {
  it('실제 라우터의 모든 변경 요청을 인증 필수 또는 계정 복구로 분류한다', () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string; meta?: ProcedureMeta } }
    >;
    const mutations = Object.entries(procedures).filter(([, procedure]) => procedure._def.type === 'mutation');
    expect(mutations).toHaveLength(34);
    expect(
      mutations
        .filter(([, procedure]) => procedure._def.meta?.accountAccess === 'verified')
        .map(([path]) => path)
        .sort(),
    ).toEqual(VERIFIED_MUTATIONS);
    expect(
      mutations
        .filter(([, procedure]) => procedure._def.meta?.accountAccess === 'recovery')
        .map(([path]) => path)
        .sort(),
    ).toEqual(RECOVERY_MUTATIONS);
    expect(mutations.filter(([, procedure]) => !procedure._def.meta?.accountAccess)).toEqual([]);
    expect(
      mutations
        .filter(([, procedure]) => procedure._def.meta?.worldSanction)
        .map(([path]) => path)
        .sort(),
    ).toEqual(VERIFIED_MUTATIONS.filter((path) => !path.startsWith('admin.')));
  });
});
