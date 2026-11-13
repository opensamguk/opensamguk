import { Client } from 'pg';
import type { ServerResponse } from 'node:http';
import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify';
import { worldChannel, type PrismaClient, type RealtimeSignal, type RealtimeTarget } from '@opensamguk/db';
import { z } from 'zod';
import { authenticate } from '../auth/session';
import { worldInput } from '../queries';

const id = z.number().int().min(1).max(2147483647);
const targetSchema = z.union([
  z.literal('world'),
  z.strictObject({ generalId: id }),
  z.strictObject({ nationId: id }),
  z.strictObject({ nationIds: z.array(id).min(1).max(2), leadersOnly: z.boolean().optional() }),
]);
const signalSchema = z
  .strictObject({
    kind: z.enum([
      'activity.updated',
      'turn.result',
      'message.new',
      'monthly.done',
      'offer.new',
      'treaty.new',
      'notice.updated',
    ]),
    target: targetSchema,
    scope: z.enum(['PRIVATE', 'NATION', 'DIPLOMACY', 'WORLD', 'nation', 'world']).optional(),
  })
  .superRefine((value, ctx) => {
    const t = value.target;
    const general = typeof t === 'object' && 'generalId' in t;
    const nation = typeof t === 'object' && 'nationId' in t;
    const nations = typeof t === 'object' && 'nationIds' in t;
    const valid =
      value.kind === 'turn.result'
        ? general && value.scope === undefined
        : value.kind === 'monthly.done' || value.kind === 'activity.updated'
          ? t === 'world' && value.scope === undefined
          : value.kind === 'offer.new'
            ? (general || (nations && t.leadersOnly === true)) && value.scope === undefined
            : value.kind === 'treaty.new'
              ? nations && !t.leadersOnly && value.scope === undefined
              : value.kind === 'notice.updated'
                ? (value.scope === 'world' && t === 'world') || (value.scope === 'nation' && nation)
                : (value.scope === 'PRIVATE' && general) ||
                  (value.scope === 'NATION' && nation) ||
                  (value.scope === 'DIPLOMACY' && nations && t.leadersOnly === true) ||
                  (value.scope === 'WORLD' && t === 'world');
    if (!valid) ctx.addIssue({ code: 'custom', message: '알림 범위가 올바르지 않습니다.' });
  });
export interface RealtimeOptions {
  connectionString?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  applicationName?: string;
  admission?: { total: number; perAccount: number; preparing: number; deadlineMs: number };
}
interface Connection {
  worldId: string;
  sessionId: string;
  userId: string;
  response: ServerResponse;
  inFlight: number;
  release: () => void;
}
interface Audience {
  id: number;
  nationId: number | null;
  officerLevel: number;
}
function eligible(a: Audience, target: RealtimeTarget) {
  if (target === 'world') return true;
  if ('generalId' in target) return a.id === target.generalId;
  if ('nationId' in target) return a.nationId === target.nationId;
  return (
    a.nationId !== null &&
    target.nationIds.includes(a.nationId) &&
    (!target.leadersOnly || [11, 12].includes(a.officerLevel))
  );
}

export function registerRealtime<L extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    L
  >,
  db: PrismaClient,
  origin: string,
  options: RealtimeOptions = {},
  now: () => number = Date.now,
) {
  const connections = new Set<Connection>();
  const limits = options.admission ?? { total: 512, perAccount: 8, preparing: 32, deadlineMs: 5000 };
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647))
    throw new RangeError('실시간 연결 한도가 올바르지 않습니다.');
  const preparing = new Set<() => void>();
  const byAccount = new Map<string, number>();
  let streaming = 0;
  const requested = new Set<string>(['sessions_closed']);
  const listening = new Set<string>();
  let listener: Client | null = null;
  let connecting: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const warn = () => server.log.warn('실시간 알림 연결 실패');
  function detach(connection: Connection) {
    if (connections.delete(connection) && connection.inFlight === 0) connection.release();
  }
  function close(connection: Connection) {
    detach(connection);
    connection.response.end();
  }
  function closeSession(sessionId: string) {
    for (const connection of connections) if (connection.sessionId === sessionId) close(connection);
  }
  async function send(
    connection: Connection,
    kind: string | null,
    scope?: string,
    target: RealtimeTarget = 'world',
    activate?: () => boolean,
  ) {
    if (!activate && !connections.has(connection)) return;
    let admitted = !activate;
    connection.inFlight++;
    try {
      return await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${connection.userId} FOR SHARE`;
        const rows = await tx.$queryRaw<
          Audience[]
        >`SELECT g.id, g."nationId", g."officerLevel" FROM "Session" s JOIN "User" u ON u.id = s."userId" JOIN "General" g ON g."userId" = u.id WHERE s.id = ${connection.sessionId} AND u.id = ${connection.userId} AND g."worldId" = ${connection.worldId} AND u.status = 'ACTIVE' AND s."expiresAt" > clock_timestamp() FOR SHARE OF s, u, g`;
        const audience = rows[0];
        if (!audience) {
          if (admitted) close(connection);
          return 'audience-closed' as const;
        }
        if (!eligible(audience, target)) return;
        if (kind === 'ready' && (!listener || !listening.has(worldChannel(connection.worldId)))) return;
        if (activate) admitted = activate();
        if (!admitted || !connections.has(connection)) return;
        const data =
          kind === null
            ? ': hb\n\n'
            : `event: ${kind}\ndata: ${JSON.stringify({ kind, ...(scope === undefined ? {} : { scope }) })}\n\n`;
        if (!connection.response.write(data)) close(connection);
      });
    } catch {
      warn();
      if (admitted) close(connection);
    } finally {
      connection.inFlight--;
      if (admitted && connection.inFlight === 0 && !connections.has(connection)) connection.release();
    }
  }
  async function broadcastReady() {
    await Promise.all([...connections].map((c) => send(c, 'ready')));
  }
  function schedule() {
    if (closing || retry || connections.size === 0) return;
    retry = setTimeout(() => {
      retry = undefined;
      void ensure().catch(() => {
        warn();
        schedule();
      });
    }, options.reconnectMs ?? 1000);
    retry.unref();
  }
  function broken(client: Client) {
    if (listener !== client) return;
    listener = null;
    listening.clear();
    void client.end().catch(() => {});
    schedule();
  }
  async function ensure(): Promise<void> {
    if (closing) throw new Error('서버가 종료 중입니다.');
    if (connecting) {
      await connecting;
      if ([...requested].some((channel) => !listening.has(channel))) return ensure();
      return;
    }
    connecting = (async () => {
      let client = listener;
      const restoring = client === null;
      if (!client) {
        const connectionString = options.connectionString ?? process.env.DATABASE_URL;
        if (!connectionString) throw new Error('알림 DB 설정이 없습니다.');
        client = new Client({
          connectionString,
          application_name: options.applicationName ?? 'opensamguk-sse',
          connectionTimeoutMillis: 5000,
        });
        listening.clear();
        listener = client;
        const active = client;
        client.on('error', () => broken(active));
        client.on('end', () => broken(active));
        client.on('notification', (notice) => {
          if (listener !== active) return;
          if (notice.channel === 'sessions_closed') {
            if (/^[a-f0-9]{64}$/.test(notice.payload ?? '')) closeSession(notice.payload!);
            return;
          }
          let signal: RealtimeSignal;
          try {
            signal = signalSchema.parse(JSON.parse(notice.payload ?? ''));
          } catch {
            return;
          }
          for (const connection of connections)
            if (worldChannel(connection.worldId) === notice.channel)
              void send(connection, signal.kind, signal.scope, signal.target);
        });
        try {
          await client.connect();
        } catch (error) {
          broken(active);
          throw error;
        }
      }
      try {
        for (const channel of requested)
          if (!listening.has(channel)) {
            await client.query(`LISTEN "${channel}"`);
            if (listener !== client) throw new Error('알림 연결이 끊겼습니다.');
            listening.add(channel);
          }
        if (restoring) await broadcastReady();
      } catch (error) {
        broken(client);
        throw error;
      }
    })();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || closing || connections.size === 0) return;
    heartbeatBusy = true;
    void (async () => {
      if (listener) {
        const active = listener;
        try {
          await active.query('SELECT 1');
        } catch {
          broken(active);
        }
      } else schedule();
      await Promise.all([...connections].map((connection) => send(connection, null)));
    })()
      .catch(warn)
      .finally(() => {
        heartbeatBusy = false;
      });
  }, options.heartbeatMs ?? 30000);
  heartbeat.unref();
  server.get('/sse', async (request, reply) => {
    if (
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      return reply.code(403).send({ error: '같은 출처에서 요청하세요.' });
    const parsed = worldInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: '월드 ID를 확인하세요.' });
    const unavailable = () => reply.code(503).send({ error: '실시간 연결을 다시 시도하세요.' });
    if (closing) return unavailable();
    if (preparing.size >= limits.preparing || preparing.size + streaming >= limits.total)
      return reply.code(503).send({ error: '실시간 연결이 많습니다. 잠시 뒤 다시 시도하세요.' });
    let account: string | undefined;
    let expired = false;
    let connected = false;
    const deadline = performance.now() + limits.deadlineMs;
    const expire = () => {
      expired = true;
      if (!reply.raw.destroyed && !reply.sent) unavailable();
    };
    const cancelled = () => {
      if (performance.now() >= deadline && !expired) expire();
      return expired || reply.raw.destroyed || reply.sent;
    };
    preparing.add(expire);
    const timer = setTimeout(expire, limits.deadlineMs);
    timer.unref();
    const release = () => {
      if (connected) streaming--;
      if (account !== undefined) {
        const count = byAccount.get(account)!;
        if (count === 1) byAccount.delete(account);
        else byAccount.set(account, count - 1);
      }
    };
    try {
      const identity = await authenticate(db, request.cookies.sid, now(), false);
      if (cancelled()) return;
      if (!identity) return reply.code(401).send({ error: '로그인이 필요합니다.' });
      const count = byAccount.get(identity.user.id) ?? 0;
      if (count >= limits.perAccount) return reply.code(429).send({ error: '계정의 실시간 연결 한도에 도달했습니다.' });
      account = identity.user.id;
      byAccount.set(account, count + 1);
      const general = await db.general.findUnique({
        where: { worldId_userId: { worldId: parsed.data.worldId, userId: account } },
        select: { id: true },
      });
      if (cancelled()) return;
      if (!general) return reply.code(404).send({ error: '이 월드에 내 장수가 없습니다.' });
      requested.add(worldChannel(parsed.data.worldId));
      try {
        await ensure();
      } catch {
        warn();
        if (!cancelled()) return unavailable();
        return;
      }
      if (cancelled()) return;
      const connection: Connection = {
        worldId: parsed.data.worldId,
        userId: account,
        sessionId: identity.sessionId,
        response: reply.raw,
        inFlight: 0,
        release,
      };
      const openStream = () => {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
          'x-accel-buffering': 'no',
        });
      };
      const outcome = await send(connection, 'ready', undefined, 'world', () => {
        if (cancelled()) return false;
        openStream();
        connected = true;
        streaming++;
        preparing.delete(expire);
        clearTimeout(timer);
        connections.add(connection);
        reply.raw.once('close', () => detach(connection));
        return true;
      });
      if (!connected && !cancelled()) {
        if (outcome !== 'audience-closed') return unavailable();
        // 인증 뒤 폐기된 세션은 기존 계약대로 이벤트 없이 스트림을 닫는다.
        openStream();
        reply.raw.end();
      }
    } catch (error) {
      if (!cancelled()) throw error;
    } finally {
      // 응답이 먼저 닫혀도 기다리던 DB 작업이 끝난 뒤에만 자리를 반환한다.
      preparing.delete(expire);
      clearTimeout(timer);
      if (!connected) release();
    }
  });
  server.addHook('preClose', async () => {
    closing = true;
    for (const expire of preparing) expire();
    clearInterval(heartbeat);
    clearTimeout(retry);
    for (const connection of [...connections]) close(connection);
    const active = listener;
    listener = null;
    if (active) await active.end().catch(() => {});
  });
  return {
    closeSession,
    connectedSessions: (worldId: string) => [
      ...new Set([...connections].filter((connection) => connection.worldId === worldId).map((c) => c.sessionId)),
    ],
  };
}
