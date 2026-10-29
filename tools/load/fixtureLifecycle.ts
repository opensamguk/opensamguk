// 생성이 끝난 뒤 취소됐어도 정리 담당에게 소유권부터 등록한다.
export async function activateOwnedLoadWorld<T extends { worldId: string }>(
  create: () => Promise<T>,
  options: {
    signal: AbortSignal;
    onWorldCreated: (worldId: string) => void;
    startClock: (worldId: string) => Promise<unknown>;
    startEngine: (worldId: string) => Promise<void>;
  },
): Promise<T> {
  options.signal.throwIfAborted();
  const created = await create();
  options.onWorldCreated(created.worldId);
  options.signal.throwIfAborted();
  await options.startClock(created.worldId);
  options.signal.throwIfAborted();
  await options.startEngine(created.worldId);
  options.signal.throwIfAborted();
  return created;
}
