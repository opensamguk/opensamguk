// core2026 df6c926 packages/logic/src/actions/turn/general/che_선동.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import type { CommandDef } from '../../types';
import { checkStratagem, executeStratagem, stratagemArgs, type StratagemSpec } from './base';

export const inciteSpec: StratagemSpec = {
  key: 'incite',
  name: '선동',
  stat: 'leadership',
  fields: ['security', 'trust'],
  labels: ['치안', '민심'],
};

export const incite: CommandDef = {
  key: 'incite',
  name: '선동',
  category: 'strategy',
  target: 'general',
  args: stratagemArgs,
  check: checkStratagem,
  precheck: checkStratagem,
  execute: (view, actor, raw, rng) => executeStratagem(inciteSpec, view, actor, raw, rng),
};
