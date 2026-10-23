export interface PublicMapConfig {
  delayMinutes: number;
  intervalMinutes: number;
}

export function publicMapConfig(env: Readonly<Record<string, string | undefined>>): PublicMapConfig {
  const read = (key: string, fallback: number) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (
      (raw !== undefined && !/^[1-9]\d*$/.test(raw)) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      !Number.isSafeInteger(value * 60_000) ||
      value * 60_000 > 8_640_000_000_000_000
    )
      throw new Error(`${key}는 날짜 범위 안의 양의 정수(분)여야 합니다.`);
    return value;
  };
  const delayMinutes = read('PUBLIC_MAP_DELAY_MINUTES', 10);
  const intervalMinutes = read('PUBLIC_MAP_INTERVAL_MINUTES', 5);
  if (intervalMinutes > delayMinutes) throw new Error('공개 지도 저장 간격은 지연 시간보다 길 수 없습니다.');
  return { delayMinutes, intervalMinutes };
}
