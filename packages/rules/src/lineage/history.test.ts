import { expect, it } from 'vitest';
import { lineageFixture } from './testFixture';
import { decideLineageAction } from './actions';
import { lineagePublicEvents } from './history';
import { retireNpcWithoutHeir } from './succession';

it('AC-P2-32 비공개 제안은 공개 기록을 만들지 않고 당사자 수락 뒤 혼인만 기록한다', () => {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  world.generals[a!]!.userId = 'private-family-a';
  world.generals[b!]!.userId = 'private-family-b';
  const offered = decideLineageAction(world, a!, { type: 'marriage.propose', targetGeneralId: b! }, 0);
  if (!offered.ok) throw Error(offered.message);
  expect(lineagePublicEvents(world, offered.world)).toEqual([]);
  const accepted = decideLineageAction(
    offered.world,
    b!,
    { type: 'marriage.respond', offerId: offered.result.offerId!, accept: true },
    0,
  );
  if (!accepted.ok) throw Error(accepted.message);
  const events = lineagePublicEvents(offered.world, accepted.world);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ commandKey: 'lineage.marriage', generalIds: [a, b] });
  expect(JSON.stringify(events)).not.toContain('private-family');
  expect(lineagePublicEvents(accepted.world, accepted.world)).toEqual([]);
});

it('AC-P2-32 사망 정리 기록은 과거 소속 국가에 남고 개인 재산 액수는 공개하지 않는다', () => {
  const world = lineageFixture(),
    [id] = Object.keys(world.generals).map(Number),
    actor = world.generals[id!]!;
  actor.userId = null;
  actor.gold = 123456789;
  actor.rice = 987654321;
  const nationId = actor.nationId,
    result = retireNpcWithoutHeir(world, id!, 100);
  if (!result.ok) throw Error(result.message);
  const events = lineagePublicEvents(world, result.world);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    commandKey: 'lineage.death',
    generalIds: [id],
    nationIds: nationId === null ? [] : [nationId],
  });
  expect(events[0]!.text).not.toMatch(/123456789|987654321/);
});
