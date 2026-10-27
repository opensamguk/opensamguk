import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { devPortraits } from './devPortraits';

it('등록된 개발 초상만 보내고 파일 누락·변조·경로 탈출을 차단한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'int16-portraits-'));
  const child = relative(tmpdir(), root);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('임시 폴더 경계가 다릅니다.');
  const dir = join(root, 'private/portraits-supplement');
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'resources/portraits'), { recursive: true });
  await writeFile(
    join(root, 'resources/portraits/191-supplement.json'),
    await readFile(new URL('../../resources/portraits/191-supplement.json', import.meta.url)),
  );
  const server = await createServer({
    configFile: false,
    root,
    plugins: [devPortraits(root)],
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0]!;
    const get = (path: string, method = 'GET') => fetch(`${base}${path}`, { method });
    expect((await get('__dev-portraits/11001')).status).toBe(404);
    await writeFile(join(dir, '11001.jpg'), 'forged portrait');
    expect((await get('__dev-portraits/11001')).status).toBe(404);
    for (const path of ['11009', '11001.jpg', '%2e%2e/secret', '11001?file=secret']) {
      expect((await get(`__dev-portraits/${path}`)).status).toBe(404);
    }
    expect((await get('__dev-portraits/11001', 'POST')).status).toBe(404);
    // CI에는 원본을 배포하지 않는다. 실제 원본 GET 검사는 로컬 인수에서 별도로 실행한다.
    expect(await readFile(join(dir, '11001.jpg'), 'utf8')).toBe('forged portrait');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
