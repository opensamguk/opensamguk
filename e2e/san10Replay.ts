import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createDb } from '../packages/db/src/index';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

type Result = { version: number; months: ReturnType<typeof replayArchive> };

// 동기 재생 동안에도 본문의 실행권 갱신 타이머와 110초 중단 타이머가 실행되어야 한다.
export function replaySan10World(worldId: string, databaseUrl: string, phase: (value: string) => void) {
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('SAN10 재생은 시험 DB만 읽습니다.');
  return new Promise<Result>((resolve, reject) => {
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
       import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, workerData: { entry: import.meta.url, worldId, databaseUrl } },
    );
    let result: Result | undefined;
    worker.on('message', (value: { phase: string } | Result) => {
      if ('phase' in value) phase(value.phase);
      else result = value;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0 || !result) reject(new Error(`SAN10 재생 worker 종료: ${code}`));
      else resolve(result);
    });
  });
}

if (!isMainThread) {
  const db = createDb(workerData.databaseUrl);
  try {
    parentPort!.postMessage({ phase: 'replay.export' });
    const archive = await exportReplay(db, workerData.worldId);
    parentPort!.postMessage({ phase: 'replay.calculate' });
    parentPort!.postMessage({ version: archive.version, months: replayArchive(archive, 1) });
  } finally {
    await db.$disconnect();
  }
}
