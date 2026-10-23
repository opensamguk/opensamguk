// core2026 df6c926 packages/logic/src/actions/turn/general/che_선동.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { makeStratagem } from './base';

export const incite = makeStratagem({
  key: 'incite',
  name: '선동',
  stat: 'leadership',
  fields: ['security', 'trust'],
  labels: ['치안', '민심'],
});
