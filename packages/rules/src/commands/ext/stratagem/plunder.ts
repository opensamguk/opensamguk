// core2026 df6c926 packages/logic/src/actions/turn/general/che_탈취.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import type { CommandDef } from '../../types';
import { checkStratagem, executeStratagem, stratagemArgs, type StratagemSpec } from './base';

export const plunderSpec: StratagemSpec = { key: 'plunder', name: '탈취', stat: 'strength' };

export const plunder: CommandDef = {
  key: 'plunder',
  name: '탈취',
  category: 'strategy',
  target: 'general',
  args: stratagemArgs,
  check: checkStratagem,
  precheck: checkStratagem,
  execute: (view, actor, raw, rng) => executeStratagem(plunderSpec, view, actor, raw, rng),
};
