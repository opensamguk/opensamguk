import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mapBackgroundKeySchema } from '../../apps/server/src/resourceAdmin/mapBackground';
import { readWebpSize } from './webp';

const sourceSchema = z.strictObject({
  mapKey: mapBackgroundKeySchema,
  imageRepository: z.string().min(1),
  imageCommit: z.string().regex(/^[a-f0-9]{40}$/),
});

export function readMapBackgroundImage(raw: unknown) {
  const { mapKey, imageRepository, imageCommit } = sourceSchema.parse(raw);
  const objectType = execFileSync('git', ['-C', imageRepository, 'cat-file', '-t', imageCommit], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (objectType !== 'commit') throw new Error('이미지 저장소 커밋을 확인하세요.');
  const bytes = execFileSync('git', ['-C', imageRepository, 'show', `${imageCommit}:maps/${mapKey}/base.webp`], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    mapKey,
    imageCommit,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...readWebpSize(bytes),
  };
}
