import { z } from 'zod';
import { BALANCE } from '../balance';
import type { CommandDef, Failure } from './types';
export const rest: CommandDef = {
  key: 'rest', name: '휴식', target: 'general', args: z.strictObject({}),
  precheck: (view, actor): Failure | null => view.generals[actor.generalId] ? null : { code: 'NO_ACTOR', message: '장수가 없습니다.' },
  check: (view, actor): Failure | null => view.generals[actor.generalId] ? null : { code: 'NO_ACTOR', message: '장수가 없습니다.' },
  execute(view, actor) {
    if (!view.generals[actor.generalId]) throw new Error('장수가 없습니다.');
    return { effects: [{ kind: 'general', id: actor.generalId, field: 'injury', op: 'add', value: -BALANCE.REST_HEAL }],
      logs: [{ kind: 'success', text: '휴식' }] };
  },
};
