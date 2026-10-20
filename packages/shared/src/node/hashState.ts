import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('상태 해시는 유한한 숫자와 JSON 값만 받습니다.');
}

export function hashState(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
