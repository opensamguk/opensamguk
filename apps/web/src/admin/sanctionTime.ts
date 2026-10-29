export function parseSanctionExpiry(
  value: string,
  now: number,
): { ok: true; iso: string } | { ok: false; message: string } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(now))
    return { ok: false, message: '만료 시각을 확인하세요.' };
  const milliseconds = Date.parse(value + ':00+09:00');
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 16) !== value
  )
    return { ok: false, message: '만료 시각을 확인하세요.' };
  if (milliseconds <= now) return { ok: false, message: '만료 시각은 현재보다 뒤여야 합니다.' };
  return { ok: true, iso: new Date(milliseconds).toISOString() };
}
