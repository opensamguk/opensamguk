// 슬롯 그림(3 x 3칸 받침 하나). 사용자 2026-11-16 "이건 건물과 땅을 나눠야 하는 문제지.":
// 바닥 층(-ground)은 먼저 깔고, 건물 층(-building)은 사람과 함께 칸 순서로 그린다.
// 그림 규격: 768 x 768, 받침 마름모 가로가 80%, 아래 꼭짓점이 높이 85%(D:/codex-artifacts/int29-castle-slots-20261116/REQUEST-SLOT-CENTRAL.md).
// 이미지 저장소 public/art/city/slots/<양식>/<키>-<단계>[-ground|-building].webp, 빈 터와 공사 터는 slots/common.
// 만드는 법: tools/art/stage-castle-slots.py
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';

/** 받침 마름모 자리(그림 한 변에 대한 비율). */
export const SLOT_DIAMOND = { left: 0.1, width: 0.8, bottom: 0.85 } as const;

export interface SlotArt {
  /** 바닥 층. 나눈 그림이 아직 없으면 null이고 building이 바닥까지 붙은 한 장이다. */
  ground: string | null;
  building: string | null;
}

const url = (path: string) => {
  const source = `apps/web/src/art/city/slots/${path}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : null;
};

function find(style: string, name: string): SlotArt | null {
  const ground = url(`${style}/${name}-ground`);
  const building = url(`${style}/${name}-building`);
  if (ground && building) return { ground, building };
  const whole = url(`${style}/${name}`);
  return whole ? { ground: null, building: whole } : null;
}

// 용량은 서버가 땅 정보(land.slots[].capacity)로 내려 준다(INT-29 지역 고유 건물 계약). 개발 확인 판처럼
// 서버 값이 없을 때만 기본 100으로 본다.

/** 개발 점수로 그림 단계(1~3)를 고른다. 용량의 1/3, 2/3을 넘으면 한 단계씩 오른다. */
export function artLevel(_building: string, score: number, capacity: number | null = null): 1 | 2 | 3 {
  capacity ??= 100;
  const ratio = capacity > 0 ? score / capacity : 0;
  return ratio >= 2 / 3 ? 3 : ratio >= 1 / 3 ? 2 : 1;
}

/** 건물 그림. 그 양식 그림이 없으면 중원 그림, 단계 그림이 없으면 낮은 단계. */
export function slotArt(style: string, building: string, level: 1 | 2 | 3): SlotArt | null {
  for (const st of style === 'central' ? ['central'] : [style, 'central'])
    for (let lv = level; lv >= 1; lv--) {
      const art = find(st, `${building}-${lv}`);
      if (art) return art;
    }
  return null;
}

/** 성 밖 빈 터와 공사 중인 터. */
export const lotArt = (kind: 'lot-out' | 'build-out'): string | null => url(`common/${kind}`);
