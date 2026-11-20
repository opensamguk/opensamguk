import { describe, expect, it } from 'vitest';
import { wallArt } from './castleArt';

describe('칠한 성벽 그림층', () => {
  it('여섯 등급 모두 승인 목록의 뒤쪽 벽, 앞쪽 벽 그림을 쓴다', () => {
    for (const grade of ['현', '소', '중', '대', '특', '경'] as const) {
      const art = wallArt(grade);
      expect(art).not.toBeNull();
      expect(art!.back.url).toMatch(/castle-walls\/central\/wall-[a-z]+-back\.webp$/);
      expect(art!.front.url).toMatch(/castle-walls\/central\/wall-[a-z]+-front\.webp$/);
      // 앞쪽 벽은 뒤쪽 벽보다 아래(화면 앞)에서 시작한다.
      expect(art!.front.y).toBeGreaterThan(art!.back.y);
    }
    expect(wallArt(null)).toBeNull();
  });
});
