import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../packages/rules/src/world/resources';
import { createHistoricEvents1030 } from '../packages/rules/src/historicEvents/events1030';

const sql = readFileSync(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8');
const scenarioBody = sql.split('$t4_77_content$').find((body) => body.includes('"id": "1030"'));
if (!scenarioBody) throw new Error('내장 1030 시나리오가 없습니다.');
const scenario = scenarioSchema.parse(JSON.parse(scenarioBody));
const initial = {
  scenarioKey: scenario.id,
  startYear: scenario.startYear,
  nations: scenario.nation.map(([name], index) => ({ id: index + 1, name })),
};

describe('AC-P2-21 1030 역사 사건', () => {
  it('게시된 시나리오의 국가와 승인한 발생 월 및 기본 선택지를 사용한다', () => {
    const { events, windowMonths } = createHistoricEvents1030(initial);
    expect(windowMonths).toBe(2);
    expect(
      events.map(({ id, year, month, chooser, defaultOption }) => [id, year, month, chooser.nationId, defaultOption]),
    ).toEqual([
      ['E1', 194, 1, 12, 1],
      ['E2', 196, 8, 1, 1],
      ['E3', 197, 1, 6, 1],
      ['E4', 198, 12, 8, 0],
      ['E5', 199, 3, 10, 0],
      ['E6', 200, 9, 1, 0],
      ['E7', 207, 1, 13, 1],
      ['E8', 208, 10, 9, 0],
    ]);
    for (const effect of events.flatMap(({ options }) => options.flatMap(({ effects }) => effects))) {
      if (effect.kind === 'nonAggression') expect(effect.months).toBe(3);
      else expect(Math.abs(effect.value)).toBe(effect.kind === 'atmos' ? 5 : 1_000);
    }
  });

  it('게시된 1030의 다른 판도 사건에 필요한 국가가 일치하면 사용한다', () => {
    expect(createHistoricEvents1030({ ...initial, scenarioKey: '1030@2' })).toEqual(createHistoricEvents1030(initial));
    expect(() => createHistoricEvents1030({ ...initial, scenarioKey: '1030@2147483648' })).toThrow('판 번호');
  });

  it.each(['integration191', 'san10-191', '2060@2'])('같은 국가를 쓰는 %s 시나리오를 거부한다', (scenarioKey) => {
    expect(() => createHistoricEvents1030({ ...initial, scenarioKey })).toThrow('1030 시나리오');
  });

  it('생성 때마다 사본을 만들고 조합이 다른 시나리오를 거부한다', () => {
    const copy = createHistoricEvents1030(initial);
    copy.events[0]!.options[0].effects.length = 0;
    expect(createHistoricEvents1030(initial).events[0]!.options[0].effects).toEqual([
      { kind: 'nonAggression', months: 3 },
      { kind: 'gold', value: -1_000 },
    ]);
    expect(() => createHistoricEvents1030({ ...initial, nations: initial.nations.slice(0, 12) })).toThrow('국가');
  });
});
