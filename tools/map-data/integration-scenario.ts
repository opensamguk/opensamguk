import { readFileSync } from 'node:fs';
import { auditOfficerLedger } from '../officer-stats/audit';
import { mapSchema, scenarioSchema } from '../../packages/rules/src/world/resources';
import { buildOperationalMap } from './operational';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

// 안평60을 양평99의 자동 별칭으로 취급하지 않는다. 국가17의 본거지만 사료와 선택한 판에 맞춰 명시한다.
export const SCENARIO_RELOCATIONS = [
  {
    oldId: 12,
    oldName: '서주',
    nationId: 12,
    targetId: 21,
    targetName: '하비',
    reason: '도겸은 원본에서 서주12와 하비21을 소유한다. 새53도시에서는 기존 소유 도시 하비21에 수도 기능을 통합한다.',
    source: 'resources/scenario/1030.json nation[11]; resources/map/che.json',
  },
  {
    oldId: 60,
    oldName: '안평',
    nationId: 17,
    targetId: 99,
    targetName: '양평',
    reason:
      '원본 국가17 공손도의 본거지는 새판의 요동 양평으로 명시한다. 옛 안평 좌표나 다른 안평 지명의 동치를 주장하지 않는다.',
    source: 'https://zh.wikisource.org/zh-hant/三國志/卷08#公孫度',
  },
] as const;

export function buildIntegrationScenario() {
  const mainText = read('resources/scenario/1030.json');
  const original = JSON.parse(mainText) as Record<string, unknown>;
  const main = scenarioSchema.parse(original);
  const legacy = mapSchema.parse(JSON.parse(read('resources/map/che.json')));
  const map = buildOperationalMap();
  const rows = auditOfficerLedger(
    mainText,
    read('tools/fixtures/int16-selected-officers.json'),
    JSON.parse(read('resources/officers/191-five-stats.json')),
  );
  const keep = new Map(
    map.sites.flatMap((site) =>
      'legacyCityId' in site && site.legacyCityId !== undefined ? [[site.legacyCityId, site] as const] : [],
    ),
  );
  const removed: Array<{
    nationId: number;
    legacyCityId: number;
    name: string;
    role: 'FIELD' | 'CAPITAL_RELOCATION';
    targetId: number | null;
  }> = [];
  const nation = main.nation.map((row, index) => {
    const copy = structuredClone(row);
    const names: string[] = [];
    for (const name of row[8]) {
      const old = legacy.cities.find((city) => city.name === name);
      if (!old) throw new Error(`기존 국가의 도시 원본이 없습니다: ${index + 1}/${name}`);
      const anchor = keep.get(old.id);
      if (anchor) {
        names.push(anchor.name);
        continue;
      }
      const relocation = SCENARIO_RELOCATIONS.find((entry) => entry.oldId === old.id && entry.nationId === index + 1);
      if (relocation) {
        const target = map.sites.find((site) => 'anchorKey' in site && site.anchorKey === relocation.targetId);
        if (target?.kind !== 'CITY' || target.name !== relocation.targetName)
          throw new Error('수도 대응표와 새 도시가 다릅니다.');
        names.push(target.name);
        removed.push({
          nationId: index + 1,
          legacyCityId: old.id,
          name,
          role: 'CAPITAL_RELOCATION',
          targetId: relocation.targetId,
        });
      } else if (map.sites.some((site) => site.kind === 'FIELD' && site.id === `field:${old.id}`)) {
        if (name === row[8][0]) throw new Error('수도를 전장 표시로 없앨 수 없습니다.');
        removed.push({ nationId: index + 1, legacyCityId: old.id, name, role: 'FIELD', targetId: null });
      } else throw new Error(`국가 거점의 명시적 대응이 없습니다: ${index + 1}/${old.id}/${name}`);
    }
    copy[8] = [...new Set(names)];
    return copy;
  });
  const scenario = {
    ...original,
    $comment:
      'Source: main 1030 / core2026 df6c926 (MIT); INT-03 operational mapping; INT-16 sourced five stats. See resources/NOTICE.md.',
    id: 'integration191',
    title: '통합판 191년 군웅할거',
    nation,
    generalStats: rows.map(({ generalId, stats, sourceId, sourceRevision, officerId }) => ({
      generalId,
      stats,
      sourceId,
      sourceRevision,
      officerId,
    })),
  };
  scenarioSchema.parse(scenario);
  return { scenario, removed, relocations: SCENARIO_RELOCATIONS };
}
