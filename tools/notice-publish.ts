import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDb, notifyWorld, type PrismaClient } from '../packages/db/src/index';
import { nowTick, toGameDate } from '../packages/rules/src/index';

interface Publication {
  scope: 'lobby' | 'world' | 'world-message';
  body: string;
  worldId?: string;
  title?: string;
  pinned?: boolean;
}
export async function publishNotice(db: PrismaClient, input: Publication) {
  if (!input.body.trim() || (input.scope === 'world-message' && [...input.body].length > 1000))
    throw new Error('본문을 확인하세요.');
  if (
    input.scope === 'lobby'
      ? !input.title?.trim() || input.worldId !== undefined || input.pinned
      : input.title !== undefined || !input.worldId || !/^[0-9a-f-]{36}$/.test(input.worldId)
  )
    throw new Error('공지 범위를 확인하세요.');
  if (input.scope === 'world-message' && input.pinned) throw new Error('메시지는 고정할 수 없습니다.');
  const result = await db.$transaction(async (tx) => {
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
    const world = input.worldId ? await tx.world.findUnique({ where: { id: input.worldId } }) : null;
    if (input.worldId && !world) throw new Error('월드를 찾을 수 없습니다.');
    if (input.scope === 'world-message') {
      const date = toGameDate(
        world!.startYear,
        nowTick({ ...world!, clockAnchorAt: world!.clockAnchorAt?.getTime() ?? null }, now.getTime()),
      );
      const row = await tx.message.create({
        data: {
          worldId: world!.id,
          scope: 'WORLD',
          fromParty: { generalId: null, name: '운영자', nation: null },
          body: input.body,
          sentAt: now,
          year: date.year,
          month: date.month,
        },
      });
      return { id: row.id };
    }
    const row = await tx.notice.create({
      data: {
        scope: input.scope === 'lobby' ? 'LOBBY' : 'WORLD',
        worldId: input.worldId ?? null,
        title: input.title ?? null,
        body: input.body,
        pinned: input.pinned ?? false,
        publishedAt: now,
      },
    });
    return { id: row.id };
  });
  if (input.worldId)
    await notifyWorld(
      db,
      input.worldId,
      input.scope === 'world-message'
        ? { kind: 'message.new', scope: 'WORLD', target: 'world' }
        : { kind: 'notice.updated', scope: 'world', target: 'world' },
      () => console.warn('실시간 알림 전송 실패'),
    );
  return result;
}
async function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  const values = new Map<string, string>();
  let pinned = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--pinned' && !pinned) {
      pinned = true;
      continue;
    }
    if (
      !['--scope', '--world', '--title', '--body-file'].includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith('--')
    )
      throw new Error('명령 인자를 확인하세요.');
    values.set(key, args[++i]!);
  }
  const scope = values.get('--scope');
  const file = values.get('--body-file');
  if (!['lobby', 'world', 'world-message'].includes(scope ?? '') || !file || !process.env.DATABASE_URL)
    throw new Error('공지 범위와 본문 파일, DB 설정이 필요합니다.');
  const db = createDb(process.env.DATABASE_URL);
  try {
    await publishNotice(db, {
      scope: scope as Publication['scope'],
      body: await readFile(file, 'utf8'),
      ...(values.has('--world') ? { worldId: values.get('--world')! } : {}),
      ...(values.has('--title') ? { title: values.get('--title')! } : {}),
      pinned,
    });
    console.log('게시했습니다.');
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error('공지를 게시하지 못했습니다.');
    process.exitCode = 1;
  });
