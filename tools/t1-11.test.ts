import { describe, expect, it } from 'vitest';
import { editArray } from '../packages/shared/src/editArray';
import {
  buildCreatedGeneral,
  validateGeneralCreation,
  commands,
  COMMAND_CATEGORIES,
} from '../packages/rules/src/index';
import { commandList } from '../apps/server/src/routers/commands';
import unitSet from '../resources/unitset/basic.json';

const payload = { name: '새장수', leadership: 55, strength: 55, intel: 55, portraitId: null };
const stat = { total: 165, min: 15, max: 80 };
describe('T1-11 순수 규칙과 공개 명령', () => {
  it('편집은 원본 30칸을 보존하고 양끝 포함·부호·스냅샷 반복·잘림을 지킨다', () => {
    const source = Array.from({ length: 30 }, (_, i) => i);
    expect(editArray(source, { put: { from: 1, to: 4, value: 0 } }, () => -1).slice(0, 6)).toEqual([0, 0, 0, 0, 0, 5]);
    expect(editArray(source, { shift: 1 }, () => -1)).toEqual([-1, ...source.slice(0, 29)]);
    expect(editArray(source, { shift: -1 }, () => -1)).toEqual([...source.slice(1), -1]);
    expect(editArray(source, { repeat: { from: 0, to: 1, times: 2 } }, () => -1).slice(0, 7)).toEqual([
      0, 1, 0, 1, 0, 1, 6,
    ]);
    const repeated = Array.from({ length: 30 }, (_, i) => i % 3);
    expect(editArray(source, { repeat: { from: 0, to: 2, times: 9 } }, () => -1)).toEqual(repeated);
    expect(editArray(source, { repeat: { from: 0, to: 2, times: 10 } }, () => -1)).toEqual(repeated);
    expect(editArray(source, { repeat: { from: 27, to: 28, times: 2 } }, () => -1).at(-1)).toBe(27);
    expect(source).toEqual(Array.from({ length: 30 }, (_, i) => i));
    for (const shift of [0, 30, -30, 0.5]) expect(() => editArray(source, { shift }, () => -1)).toThrow();
    expect(() => editArray(source, { repeat: { from: 0, to: 29, times: 1 } }, () => -1)).toThrow();
    expect(() => editArray(source, { put: { from: 5, to: 4, value: 0 } }, () => -1)).toThrow();
  });
  it('NFC·trim·코드포인트·정확한 합계와 실제 월드 능력치 규칙을 검사한다', () => {
    expect(validateGeneralCreation({ ...payload, name: ' 가 ' }, stat)).toMatchObject({
      ok: true,
      value: { name: '가' },
    });
    for (const name of ['', '1234567', 'a b', 'a!', '😀', 'カ'])
      expect(validateGeneralCreation({ ...payload, name }, stat).ok).toBe(false);
    expect(validateGeneralCreation({ ...payload, name: '𠀀가A123' }, stat).ok).toBe(true);
    for (const stats of [
      { leadership: 54 },
      { leadership: 56 },
      { leadership: 14, strength: 71, intel: 80 },
      { leadership: 81, strength: 42, intel: 42 },
      { strength: 55.5 },
    ])
      expect(validateGeneralCreation({ ...payload, ...stats }, stat).ok).toBe(false);
    expect(validateGeneralCreation({ ...payload, leadership: 15, strength: 70, intel: 80 }, stat).ok).toBe(true);
    expect(
      validateGeneralCreation({ ...payload, leadership: 20, strength: 20, intel: 20 }, { total: 60, min: 10, max: 30 })
        .ok,
    ).toBe(true);
    expect(validateGeneralCreation({ ...payload, portraitId: 11001 }, stat).ok).toBe(false);
  });
  it('도시 정렬·생성 RNG·다중 월 catch-up은 결정적이며 처리 tick보다 뒤다', () => {
    const input = {
      payload,
      seed: 'creation',
      userId: 'actor',
      id: 20,
      startYear: 190,
      monthlyTick: 0,
      tick: 50000,
      cityKeys: [9, 2, 4],
      unitSet,
    };
    const general = buildCreatedGeneral(input);
    expect(general).toEqual(buildCreatedGeneral({ ...input, cityKeys: [2, 4, 9] }));
    expect(general.nextTurnTick).toBeGreaterThan(50000);
    expect(general.nextTurnTick).toBeLessThanOrEqual(60000);
    expect(general).toMatchObject({ age: 20, birthYear: 170, gold: 1000, rice: 1000, nationId: null, crew: 0 });
    expect(buildCreatedGeneral({ ...input, monthlyTick: 120000, tick: 120000 }).birthYear).toBe(171);
    expect(general.affinity).toBeGreaterThanOrEqual(1);
    expect(general.affinity).toBeLessThanOrEqual(150);
  });
  it('모든 category와 JSON 입력 schema는 registry와 일치한다', () => {
    expect(commandList.map((d) => d.key)).toEqual(commands.filter((d) => d.target === 'general').map((d) => d.key));
    for (const def of commands) {
      expect(COMMAND_CATEGORIES).toContain(def.category);
      expect(def.category).toBe(def.key === 'rest' ? 'personal' : 'domestic');
    }
    for (const item of commandList)
      expect(item.argsSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });
});
