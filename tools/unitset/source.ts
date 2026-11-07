import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function readExpandedSource(): Promise<unknown> {
  const source = await readFile(new URL('./source/core2026-df6c926.json', import.meta.url));
  // 포맷만 정리한 MIT 원본이다. 원본 교체는 출처와 균형 검토를 함께 갱신한다.
  const expected = '20d927b8ac7dbc57f07f3fcfb1c902a6d5ee346d31d45cd516b36745c3b66a92';
  if (createHash('sha256').update(source).digest('hex') !== expected) throw Error('병종 원본 해시를 확인하세요.');
  return JSON.parse(source.toString('utf8'));
}

export async function readCheSource(): Promise<unknown> {
  const source = await readFile(new URL('./source/che-core2026-df6c926.json', import.meta.url));
  const expected = '20d4503b9debc4f2ff1a91ca40280b9c85e35eb3105d6c891cbf5241954785a1';
  if (createHash('sha256').update(source).digest('hex') !== expected) throw Error('che 병종 원본 해시를 확인하세요.');
  return JSON.parse(source.toString('utf8'));
}

export async function readCheExceptSiegeSource(): Promise<unknown> {
  const source = await readFile(new URL('./source/che-except-siege-core2026-df6c926.json', import.meta.url));
  const expected = '1a835c5dcb6f8709c6d34ec1c8dbd9caa92169c8ab6c1f831f700bc596d79c7b';
  if (createHash('sha256').update(source).digest('hex') !== expected)
    throw Error('che_except_siege 병종 원본 해시를 확인하세요.');
  return JSON.parse(source.toString('utf8'));
}

const alternateSourceHashes = {
  cr: '3c08bb4ee0842a181809259ccd8f58859792d5354b0e2e38256a7db370311c86',
  siegetank: 'fc1009177b525c5376b3ea524c5d691dbb9a6d26789897cd64218ffe78f462ea',
  ludo_rathowm: '3eb793012468d8b211ea7200ce5ac350b2891469d58f2c4310775f3d4eed4b5a',
};

export async function readAlternateCheSource(id: keyof typeof alternateSourceHashes): Promise<unknown> {
  const source = await readFile(new URL(`./source/${id}-core2026-df6c926.json`, import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== alternateSourceHashes[id])
    throw Error(`원작 병종 원본 해시를 확인하세요. ${id}`);
  return JSON.parse(source.toString('utf8'));
}
