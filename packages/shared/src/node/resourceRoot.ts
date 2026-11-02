import { statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 운영 번들의 위치와 무관하게 같은 자료 디렉터리를 읽는다. */
export function resourceRoot(env: NodeJS.ProcessEnv = process.env): URL {
  const configured = env.OPENSAMGUK_RESOURCES_ROOT;
  if (configured === undefined && env.NODE_ENV !== 'production')
    return new URL('../../../../resources/', import.meta.url);
  try {
    if (!configured || !isAbsolute(configured) || !statSync(configured).isDirectory()) throw new Error();
    return pathToFileURL(configured + sep);
  } catch {
    throw new Error('OPENSAMGUK_RESOURCES_ROOT에 자료 디렉터리의 절대 경로를 지정하세요.');
  }
}
