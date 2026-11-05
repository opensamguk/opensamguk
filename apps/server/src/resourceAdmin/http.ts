import type { FastifyReply, FastifyRequest } from 'fastify';
import { RESOURCE_HTTP_LIMITS } from './httpLimits';

export function resourceAdminHttpGuard(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params;
  if (typeof params !== 'object' || params === null || !('path' in params) || typeof params.path !== 'string') return;
  // Fastify와 tRPC가 함께 쓰는 디코딩된 경로에서 실행 전에 제한한다.
  const paths = params.path.split(',');
  const resources = paths.filter((path) => path.startsWith('resourceAdmin.'));
  if (!resources.length) return;
  const accept = request.headers['trpc-accept'] ?? request.headers.accept;
  const value = Array.isArray(accept) ? accept.join(', ') : (accept ?? '');
  const streaming =
    request.headers['trpc-accept'] !== undefined
      ? value === 'application/jsonl'
      : value.split(',').some((part) => part.trim() === 'application/jsonl');
  if (paths.length > RESOURCE_HTTP_LIMITS.batchMax || resources.length !== paths.length || streaming) {
    return reply.code(400).send({
      error: {
        code: -32600,
        message: '자원 요청은 JSON으로 최대 4개씩 보내고 다른 API와 묶지 마세요.',
        data: { code: 'BAD_REQUEST', httpStatus: 400, reason: null },
      },
    });
  }
}
