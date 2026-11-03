import { expect, it } from 'vitest';
import type { ReplayState } from '../replay';
import { emptyTurns } from '../replayInputs';
import { emptyQueue } from '../policy';
import { assertReplayPolicy } from '../policy/replay';
import { updateResidenceAnchors } from '../personnel/residence';
import { LINEAGE_MAX } from './config';
import { lineageControlRevisions, resetLineageControl } from './control';
import { applySuccession } from './succession';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';

it.each([false, true])(
  'AC-P2-32 계승은 양쪽 옛 revision을 넘겨 예약을 비우고 활동·거주를 옮긴다 policy=%s',
  (withPolicy) => {
    const world = lineageFixture(),
      ids = Object.keys(world.generals).map(Number),
      [from, to, mother] = ids;
    Object.assign(world.generals[from!]!, { userId: 'lineage-player', crew: 0 });
    Object.assign(world.generals[to!]!, {
      userId: null,
      nationId: world.generals[from!]!.nationId,
      cityKey: world.generals[from!]!.cityKey,
      officerLevel: 1,
      crew: 0,
    });
    world.generals[mother!]!.sex = 'FEMALE';
    world.lineage!.persons[String(to)] = { ...emptyLineagePerson(), parents: [from!, mother!] };
    if (withPolicy) world.ruleFeatures!.push('policy');
    const before: ReplayState = {
      state: world,
      monthlyTick: 0,
      turns: Object.fromEntries(ids.map((id) => [id, withPolicy ? emptyQueue() : emptyTurns()])),
      revisions: Object.fromEntries(ids.map((id) => [id, id === from ? 10 : id === to ? 5 : 0])),
      residenceAnchors: { [from!]: 5 },
      ...(withPolicy
        ? {
            policy: {
              turnTermMinutes: 60,
              policies: Object.fromEntries(ids.map((id) => [id, 'none' as const])),
              lastActiveTicks: { [from!]: 5 },
            },
          }
        : {}),
    };
    before.turns[to!]![0] = { commandKey: 'move', args: { cityKey: 2 }, ...(withPolicy ? { explicit: true } : {}) };
    if (before.policy) before.policy.policies[to!] = 'commerce';
    const outcome = applySuccession(world, from!, to!, 'HUMAN', 100);
    if (!outcome.ok) throw Error(outcome.message);
    const saved = structuredClone(before),
      after = resetLineageControl(before, { ...before, state: outcome.world }, from!, to!, 'HUMAN', 100);
    expect(before).toEqual(saved);
    expect(after.revisions[from!]).toBe(11);
    expect(after.revisions[to!]).toBe(11);
    expect(after.turns[to!]).toEqual(withPolicy ? emptyQueue() : emptyTurns());
    if (after.policy) expect(after.policy.policies[to!]).toBe('none');
    expect(after.residenceAnchors).toEqual({ [to!]: 100 });
    if (withPolicy) {
      expect(after.policy!.lastActiveTicks).toEqual({ [to!]: 100 });
      expect(() => assertReplayPolicy(after)).not.toThrow();
    }
    expect(() =>
      updateResidenceAnchors({
        before: world,
        after: outcome.world,
        anchors: { [from!]: 5 },
        tick: 100,
        createdHumanId: null,
      }),
    ).toThrow('NPC');
    expect(() =>
      updateResidenceAnchors({
        before: world,
        after: outcome.world,
        anchors: { [from!]: 5 },
        tick: 100,
        createdHumanId: null,
        succession: { fromId: mother!, toId: to! },
      }),
    ).toThrow('출처');
  },
);

it('AC-P2-32 계승 revision 상한은 원래 두 번호를 바꾸지 않고 거절한다', () => {
  expect(lineageControlRevisions(LINEAGE_MAX, 0)).toMatchObject({ ok: false, code: 'LIMIT' });
  expect(lineageControlRevisions(LINEAGE_MAX - 1, 0)).toMatchObject({ ok: false, code: 'LIMIT' });
  expect(lineageControlRevisions(0, LINEAGE_MAX - 1)).toMatchObject({ ok: false, code: 'LIMIT' });
  expect(lineageControlRevisions(4, 9)).toEqual({ ok: true, fromRevision: 5, toRevision: 10 });
});
