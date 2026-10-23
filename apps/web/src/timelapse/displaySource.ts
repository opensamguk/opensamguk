import type { FrameNation, NationDisplaySource, StoredNation, TimelapseFrame } from './frames';

// 프레임마다 그 달에 저장된 국가 값(frames.items[].nations)만 쓰는 출처 (T4-56 프레임 조회).
// 응답의 currentNations는 지금 국가 행 값이라 과거 프레임에 쓰지 않는다. 저장값이 없으면 missing으로 알린다.
export function storedNationSource(frames: readonly TimelapseFrame[]): NationDisplaySource {
  const byTick = new Map<number, Map<number, StoredNation>>(
    frames.map((frame) => [frame.tick, new Map(frame.nations.map((nation) => [nation.id, nation]))]),
  );
  return {
    resolve(frameTick, nationId): FrameNation {
      if (nationId === null) return { kind: 'empty' };
      const stored = byTick.get(frameTick)?.get(nationId);
      return stored
        ? { kind: 'stored', id: stored.id, name: stored.name, color: stored.color }
        : { kind: 'missing', id: nationId };
    },
  };
}
