import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthzEvidence, Category } from './coverage';

export const evidenceFile = fileURLToPath(new URL('../../.authz/cases.json', import.meta.url));
export function authzCase(path: string, category: Category, fn: () => Promise<void>) {
  return async () => {
    await fn();
    // 콜백이 끝까지 통과한 뒤에만 남긴다. skip·실패는 실행 증거가 아니다.
    if (process.env.AUTHZ_RECORD !== '1') return;
    mkdirSync(fileURLToPath(new URL('../../.authz/', import.meta.url)), { recursive: true });
    const evidence: AuthzEvidence[] = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : [];
    evidence.push({ path, category });
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  };
}
