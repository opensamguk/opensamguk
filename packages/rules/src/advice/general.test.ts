import { describe, expect, it } from 'vitest';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver } from '../commands/resolve';
import { generalTurnCandidates } from '../npc';
import { adviseGeneral, type AdviceContext } from './general';

const context: AdviceContext = { tick: 100, unitSet: testUnits, resolver: createCommandResolver(null) };
const suggestion = (commandKey: string, args: Record<string, never> = {}) => ({ commandKey, args, reason: commandKey });
const operation = (id: string, targetTick: number, commandKey: string) => ({
  id,
  targetTick,
  ...suggestion(commandKey),
});

describe('AC-M3-13 군사 조언', () => {
  it('실제 사람 장수의 후보를 재사용하고 입력과 소유권을 보존한다', () => {
    const view = commandWorld();
    view.generals[1]!.userId = 'human';
    const before = structuredClone(view);
    const advice = adviseGeneral(view, 1, context);
    expect(advice.items).toHaveLength(3);
    expect(advice.items.every((item) => item.source === 'ai' && item.reason.length > 0)).toBe(true);
    const candidates = generalTurnCandidates(view, view.generals[1]!, context);
    for (const item of advice.items) {
      expect(candidates).toContainEqual(
        expect.objectContaining({ key: item.commandKey, args: item.args, score: item.score }),
      );
      expect(
        context.resolver.precheck(
          view,
          { generalId: 1, tick: context.tick, unitSet: testUnits },
          item.commandKey,
          item.args,
        ),
      ).toBeNull();
    }
    expect(adviseGeneral(view, 1, context)).toEqual(advice);
    expect(view).toEqual(before);
  });

  it('작전은 시각·ID 순이며 같은 지시는 첫 출처만 남기고 공지 뒤 AI로 세 개를 채운다', () => {
    const view = commandWorld();
    const operations = [operation('z', 200, 'rest'), operation('a', 100, 'heal')];
    const result = adviseGeneral(view, 1, { ...context, operations, directive: suggestion('heal') });
    expect(result.items.slice(0, 2).map((item) => [item.source, item.commandKey])).toEqual([
      ['operation', 'heal'],
      ['operation', 'rest'],
    ]);
    expect(result.items).toHaveLength(3);
    expect(result.items[2]!.source).toBe('ai');
    expect(result).toEqual(
      adviseGeneral(view, 1, { ...context, operations: operations.toReversed(), directive: suggestion('heal') }),
    );
    const noticeFirst = adviseGeneral(view, 1, { ...context, directive: suggestion('rest') });
    expect(noticeFirst.items[0]).toMatchObject({ source: 'notice', commandKey: 'rest', score: null });
  });

  it('꺼진 명령·국가 명령·잘못된 인자·실행 불가 지시는 건너뛰고 실패 이유를 남긴다', () => {
    const view = commandWorld();
    const result = adviseGeneral(view, 1, {
      ...context,
      operations: [
        operation('a', 100, 'not_enabled'),
        operation('b', 100, 'nation_rest'),
        { id: 'c', targetTick: 100, ...suggestion('move'), args: { cityKey: 999 } },
      ],
      directive: { ...suggestion('rest'), args: { invalid: true } },
    });
    expect(result.skipped).toHaveLength(4);
    expect(result.skipped[0]).toMatchObject({ source: 'operation', code: 'COMMAND_DISABLED' });
    expect(result.skipped[1]).toMatchObject({ code: 'BAD_ARGS' });
    expect(result.skipped[3]).toMatchObject({ source: 'notice', code: 'BAD_ARGS' });
    expect(result.items.every((item) => item.source === 'ai')).toBe(true);
  });

  it('재야는 허용된 임관만 추천하고 공지·작전은 받지 않는다', () => {
    const view = commandWorld();
    view.generals[4]!.userId = 'free-human';
    const result = adviseGeneral(view, 4, {
      ...context,
      operations: [operation('a', 100, 'rest')],
      directive: suggestion('heal'),
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.nation?.id)).toEqual([1, 2]);
    expect(
      result.items.every((item) => item.commandKey === 'join' && item.score === null && item.source === 'ai'),
    ).toBe(true);
    expect(result.items[0]!.argsLabel).toBe('국가1');
    expect(result.skipped).toEqual([]);
  });

  it('인자 키 순서가 다른 같은 명령도 작전 한 번만 추천한다', () => {
    const view = commandWorld();
    const result = adviseGeneral(view, 1, {
      ...context,
      operations: [
        { id: 'a', targetTick: 100, commandKey: 'trade_rice', args: { amount: 10, buy: true }, reason: '작전' },
      ],
      directive: { commandKey: 'trade_rice', args: { buy: true, amount: 10 }, reason: '공지' },
    });
    expect(result.items.filter((item) => item.commandKey === 'trade_rice')).toEqual([
      expect.objectContaining({ source: 'operation', argsLabel: '수량 10 · 쌀 사기' }),
    ]);
  });

  it('다음 명령 시각에 미등장·제거된 장수는 조언이 비어 있다', () => {
    const view = commandWorld();
    view.generals[1]!.activeFromYear = 192;
    expect(adviseGeneral(view, 1, context)).toEqual({ items: [], skipped: [] });
    expect(adviseGeneral(view, 1, { ...context, tick: 12 * 10000 })).not.toEqual({ items: [], skipped: [] });
    view.generals[1]!.removedAt = 1;
    expect(adviseGeneral(view, 1, { ...context, tick: 12 * 10000 })).toEqual({ items: [], skipped: [] });
    expect(adviseGeneral(view, 999, context)).toEqual({ items: [], skipped: [] });
  });
});
