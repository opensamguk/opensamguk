import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export async function readReleasePublicAssets(root: string, dist: string) {
  const policy = z
    .object({
      delivery: z.literal('external').optional(),
      portraitPolicy: z.enum(['fallback-only', 'remote']),
      remoteImageBases: z.array(z.string()),
      externalAssetOrigins: z.array(z.string()).length(0),
    })
    .parse(JSON.parse(await readFile(join(root, 'manifest/public-assets.json'), 'utf8')));
  const metadata = z
    .object({ mode: z.literal('public'), imageBaseUrl: z.string(), images: z.array(z.unknown()) })
    .parse(JSON.parse(await readFile(join(dist, 'public-build.json'), 'utf8')));
  const external = policy.delivery === 'external';
  const approvedBase =
    policy.portraitPolicy === 'remote'
      ? external && metadata.imageBaseUrl !== '' && policy.remoteImageBases.includes(metadata.imageBaseUrl)
      : metadata.imageBaseUrl === '' && policy.remoteImageBases.length === 0;
  if (!approvedBase || metadata.images.length !== (external ? 0 : 6))
    throw new Error('릴리스 공개 이미지 정책과 빌드가 다릅니다.');
  if (external) {
    const { checkPublicAssets } = await import('./public-assets/check');
    await checkPublicAssets({ root, dist });
  }
  return {
    imageBaseUrl: metadata.imageBaseUrl,
    portraitPolicy: policy.portraitPolicy,
    externalPortraits: policy.portraitPolicy === 'remote' ? policy.remoteImageBases.length : 0,
  };
}
