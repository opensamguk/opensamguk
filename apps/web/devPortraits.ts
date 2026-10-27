import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';

// D-004·D-031: 원본은 Git 밖 private에만 두고 개발 서버에서만 읽는다.
export function devPortraits(repoRoot: string): Plugin {
  return {
    name: 'opensamguk:dev-portraits',
    apply: 'serve',
    async configureServer(server) {
      const manifest = JSON.parse(
        await readFile(join(repoRoot, 'resources/portraits/191-supplement.json'), 'utf8'),
      ) as {
        portraits: { id: number; filename: string; bytes: number; sha256: string; mime: string }[];
      };
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/__dev-portraits/')) return next();
        const match = /^\/__dev-portraits\/(1100[1-8])$/.exec(request.url);
        const row = match && manifest.portraits.find(({ id }) => id === Number(match[1]));
        if (!row || !['GET', 'HEAD'].includes(request.method ?? '')) {
          response.statusCode = 404;
          response.end();
          return;
        }
        void readFile(join(repoRoot, 'private/portraits-supplement', row.filename))
          .then((bytes) => {
            if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
              throw new Error('초상 원본의 내용 해시가 다릅니다.');
            }
            response.setHeader('Content-Type', row.mime);
            response.setHeader('Content-Length', bytes.length);
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cache-Control', 'private, max-age=3600');
            response.end(request.method === 'HEAD' ? undefined : bytes);
          })
          .catch(() => {
            response.statusCode = 404;
            response.end();
          });
      });
    },
  };
}
