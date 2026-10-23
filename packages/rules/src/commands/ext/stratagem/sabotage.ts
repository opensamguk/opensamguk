// core2026 df6c926 packages/logic/src/actions/turn/general/che_파괴.ts 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { makeStratagem } from './base';

export const sabotage = makeStratagem({
  key: 'sabotage',
  name: '파괴',
  stat: 'strength',
  fields: ['defence', 'wall'],
  labels: ['수비', '성벽'],
});
