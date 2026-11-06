import type { FastifyReply, FastifyRequest } from 'fastify';
import { RESOURCE_HTTP_LIMITS } from './httpLimits';

export function resourceAdminHttpGuard(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params;
  if (typeof params !== 'object' || params === null || !('path' in params) || typeof params.path !== 'string') return;
  // Fastify의 디코딩 뒤 resolveResponse가 한 번 더 디코딩한 경로로 호출을 나눈다.
  let path: string;
  try {
    path = decodeURIComponent(params.path);
  } catch {
    // tRPC도 이 경로는 실행하지 못하며 기존 잘못된 URI 응답으로 처리한다.
    return;
  }
  const paths = path.split(',');
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
