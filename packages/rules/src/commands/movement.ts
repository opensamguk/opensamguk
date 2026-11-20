// 이 명령 뒤의 영지 좌표는 다른 도시를 가리킬 수 있다. 성공 여부와 관계없이 보존한다.
export const CITY_CHANGING_COMMANDS: ReadonlySet<string> = new Set([
  'move',
  'return',
  'return_border',
  'attack',
  'join',
  'join_random',
  'accept_invite',
]);
