import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function readExpandedSource(): Promise<unknown> {
  const source = await readFile(new URL('./source/core2026-df6c926.json', import.meta.url));
  // 포맷만 정리한 MIT 원본이다. 원본 교체는 출처와 균형 검토를 함께 갱신한다.
  const expected = '20d927b8ac7dbc57f07f3fcfb1c902a6d5ee346d31d45cd516b36745c3b66a92';
  if (createHash('sha256').update(source).digest('hex') !== expected) throw Error('병종 원본 해시를 확인하세요.');
  return JSON.parse(source.toString('utf8'));
}
