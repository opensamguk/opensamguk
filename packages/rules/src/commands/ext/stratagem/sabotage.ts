// core2026 df6c926 packages/logic/src/actions/turn/general/che_파괴.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import type { CommandDef } from '../../types';
import { checkStratagem, executeStratagem, stratagemArgs, type StratagemSpec } from './base';

export const sabotageSpec: StratagemSpec = {
  key: 'sabotage',
  name: '파괴',
  stat: 'strength',
  fields: ['defence', 'wall'],
  labels: ['수비', '성벽'],
};

export const sabotage: CommandDef = {
  key: 'sabotage',
  name: '파괴',
  category: 'strategy',
  target: 'general',
  args: stratagemArgs,
  check: checkStratagem,
  precheck: checkStratagem,
  execute: (view, actor, raw, rng) => executeStratagem(sabotageSpec, view, actor, raw, rng),
};
