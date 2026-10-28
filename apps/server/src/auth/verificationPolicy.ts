export function emailVerificationRequired(
  env: NodeJS.ProcessEnv,
  options: { production?: boolean; emailVerificationRequired?: boolean } = {},
): boolean {
  const production = env.NODE_ENV === 'production' || options.production === true;
  const configured = env.EMAIL_VERIFICATION_REQUIRED;
  if (configured !== undefined && configured !== '0' && configured !== '1')
    throw new Error('EMAIL_VERIFICATION_REQUIRED는 0 또는 1이어야 합니다.');
  if (production && (configured === '0' || options.production === false || options.emailVerificationRequired === false))
    throw new Error('운영 환경에서는 이메일 인증을 꺼둘 수 없습니다.');
  return production || (options.emailVerificationRequired ?? configured === '1');
}
