import type { FrameNation, NationDisplaySource, StoredNation } from './frames';

// 응답 items[] 하나에서 표시값 출처가 읽는 칸. nations는 그 프레임 tick에 저장된 YearbookNation 값이다 (T4-56 (가)).
export interface SavedFrame {
  tick: number;
  nations: readonly StoredNation[];
}

// 이은 프레임만 받는다. currentNations와 지도의 nations는 인자로 들어갈 자리가 없다.
// 같은 tick 프레임의 nations에 그 id가 꼭 한 번 있을 때만 그 이름·색을 그대로 쓴다. 없거나 두 번 이상이면 missing이다.
// 다른 프레임이나 지금 국가 행에서 찾지 않고 기본 이름·색도 만들지 않는다 (docs/plans/T4-36.md 2.3).
export function savedNationSource(frames: readonly SavedFrame[]): NationDisplaySource {
  const byTick = new Map<number, Map<number, StoredNation | null>>();
  for (const frame of frames) {
    const nations = new Map<number, StoredNation | null>();
    for (const nation of frame.nations) nations.set(nation.id, nations.has(nation.id) ? null : nation);
    byTick.set(frame.tick, nations);
  }
  return {
    resolve(frameTick, nationId): FrameNation {
      if (nationId === null) return { kind: 'empty' };
      const stored = byTick.get(frameTick)?.get(nationId);
      if (!stored) return { kind: 'missing', id: nationId };
      return { kind: 'stored', id: nationId, name: stored.name, color: stored.color };
    },
  };
}
