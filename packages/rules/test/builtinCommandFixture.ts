import { commandWorld as providedWorld } from './commandFixture';
export { testUnits, commandInitial } from './commandFixture';

// 원래 명령 정의의 개인 병력 입력이다. 상시 규칙 resolver 시험은 commandFixture의 부곡을 쓴다.
export function commandWorld() {
  const world = providedWorld();
  for (const general of Object.values(world.generals)) general.crew = [10000, 20, 10, 100][general.id - 1]!;
  world.campaign!.units = [];
  world.campaign!.nextUnitId = 1;
  return world;
}
