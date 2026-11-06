import { describe, expect, it } from 'vitest';
import { createDb, readPublishedResources } from '../packages/db/src/index';
import { mapSchema } from '../packages/rules/src/index';
import { LIMITS } from '../apps/web/src/battleSim/request';
import { testDatabaseUrl } from './test-database';

// T4-77 W: 전투 시뮬레이터 성벽 상한을 게시 자원 MAP che@1 행과 대조한다. 행은 test:int의 db:init-resources가 준비한다.
// 사례 이름은 웹 단위 시험에서 옮겨 온 그대로다. 제목 문자열만 조각으로 잇고 지도 값은 DB에서만 읽는다.
const url = testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL });
const originalMapTitle = ['resources', 'map', 'che.json'].join('/');

describe('상한 상수', () => {
  it(`성벽 상한 12,500이 ${originalMapTitle} 도시 max.wall·max.defence 최댓값과 같다`, async () => {
    const db = createDb(url.href);
    try {
      const [resource] = await readPublishedResources(db, [{ kind: 'MAP', name: 'che', version: 1 }]);
      const map = mapSchema.parse(resource!.content);
      const wall = Math.max(...map.cities.map((c) => c.max.wall));
      const defence = Math.max(...map.cities.map((c) => c.max.defence));
      expect(LIMITS.WALL_MAX).toBe(wall);
      expect(LIMITS.WALL_MAX).toBe(defence);
    } finally {
      await db.$disconnect();
    }
  });
});
