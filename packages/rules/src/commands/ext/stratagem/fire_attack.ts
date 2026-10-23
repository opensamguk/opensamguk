// core2026 df6c926 packages/logic/src/actions/turn/general/che_화계.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { makeStratagem } from './base';

export const fire_attack = makeStratagem({
  key: 'fire_attack',
  name: '화계',
  stat: 'intel',
  fields: ['agriculture', 'commerce'],
  labels: ['농업', '상업'],
});
