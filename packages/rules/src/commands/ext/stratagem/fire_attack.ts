// core2026 df6c926 packages/logic/src/actions/turn/general/che_화계.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import type { CommandDef } from '../../types';
import { checkStratagem, executeStratagem, stratagemArgs, type StratagemSpec } from './base';

export const fireAttackSpec: StratagemSpec = {
  key: 'fire_attack',
  name: '화계',
  stat: 'intel',
  fields: ['agriculture', 'commerce'],
  labels: ['농업', '상업'],
};

export const fire_attack: CommandDef = {
  key: 'fire_attack',
  name: '화계',
  category: 'strategy',
  target: 'general',
  args: stratagemArgs,
  check: checkStratagem,
  precheck: checkStratagem,
  execute: (view, actor, raw, rng) => executeStratagem(fireAttackSpec, view, actor, raw, rng),
};
