import { afterAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import {
  settleReplayMonth,
  lineageConfigSchema,
  providedRuleData,
  emptyLineagePerson,
  runReplayAction,
  runGeneralTurn,
  resolverForRuleFeatures,
  completePersonnelStep,
  updateResidenceAnchors,
  reputationTurnEvents,
  TICKS_PER_MONTH,
} from '@opensamguk/rules';
import { persistCityLandTurns, persistEffects, shiftTurns } from './persist';
import { persistPersonnelPacket } from './ruleFeatures';
import { appendReputationEvents } from './reputationState';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { prepareInitialWorld, savePreparedInitialWorld } from './world/persistence';
import { loadReplayState, persistMonthly } from './monthly';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).host !== '127.0.0.1:5561' || new URL(url).pathname !== '/opensamguk_int30_test')
  throw new Error('INT-30 전용 시험 DB가 필요합니다.');
const db = createDb(url);
afterAll(() => db.$disconnect());

it.each([
  'birth',
  'succession',
  'upgrade',
  'birth-upgrade',
  'succession-upgrade',
  'shrink',
  'birth-shrink',
  'succession-shrink',
  'null-state-upgrade',
  'null-state-shrink',
])('AC-INT-30 / AC-P2-32 실제 월 정산과 재조회 해시: %s', async (scenario) => {
  const initial = await monthlyFixture();
  initial.scenarioKey = 'int30-regression';
  initial.generals[0]!.sex = 'MALE';
  initial.generals[1]!.sex = 'FEMALE';
  initial.cities[0]!.state = 0;
  initial.cities[0]!.stateTerm = 0;
  initial.cities[0]!.parentCityKey = 2;
  if (scenario.startsWith('null-state')) {
    delete initial.cities[0]!.state;
    delete initial.cities[0]!.stateTerm;
    delete initial.cities[0]!.parentCityKey;
  }
  initial.cities[0]!.level = 2;
  initial.cities[1]!.level = 5;
  const source = initial.operationalMap!.sites.find((site) => site.kind === 'CITY' && site.anchorKey === 1)!;
  if (source.kind !== 'CITY') throw Error('도시 고정물이 필요합니다.');
  initial.operationalMap!.siteClassification = 'd096';
  source.level = 2;
  source.parentCityKey = 2;
  const parent = initial.operationalMap!.sites.find((site) => site.kind === 'CITY' && site.anchorKey === 2)!;
  if (parent.kind !== 'CITY') throw Error('모성 고정물이 필요합니다.');
  parent.level = 5;
  const config = lineageConfigSchema.parse(providedRuleData(initial, 60)['lineage-v1']);
  config.marriage.npc.perMonth = 0;
  config.birth.chanceBp = scenario.startsWith('birth') ? 10000 : 0;
  const prepared = prepareInitialWorld(initial, {
    featureData: { 'lineage-v1': config },
    name: 'INT-30 결함 회귀',
    turnTermMinutes: 60,
    endYear: null,
  });
  const rollback = new Error('시험 트랜잭션 원복');
  await expect(
    db.$transaction(
      async (tx) => {
        const { worldId } = await savePreparedInitialWorld(tx, prepared, undefined, false);
        await tx.$queryRaw`SELECT id FROM "World" WHERE id=${worldId} FOR UPDATE`;
        // 회귀 조건만 트랜잭션 안에서 준비하고 끝에 전부 원복한다.
        await tx.general.updateMany({
          where: { worldId },
          data: { deathYear: 250, activeFromYear: 175, cityKey: 1, nationId: 1 },
        });
        await tx.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { officerLevel: 12 } });
        await tx.general.update({ where: { worldId_id: { worldId, id: 2 } }, data: { officerLevel: 1 } });
        const setup = await loadReplayState(tx, worldId);
        if (scenario.startsWith('null-state')) {
          const stored = await tx.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 1 } } });
          expect(stored.state).toBeNull();
          expect(setup.state.cities[1]).not.toHaveProperty('state');
          expect(setup.state.cities[1]).not.toHaveProperty('parentCityKey');
        }
        const lineage = setup.state.lineage!;

        if (scenario.startsWith('birth')) {
          lineage.marriages = [{ id: 1, a: 1, b: 2, householdGeneralId: 1, sinceTick: 0 }];
          lineage.nextMarriageId = 2;
        }
        if (scenario.startsWith('succession')) {
          lineage.persons['3'] = { ...emptyLineagePerson(), parents: [1, 2] };
          await tx.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { deathYear: 190 } });
          await tx.general.update({ where: { worldId_id: { worldId, id: 3 } }, data: { officerLevel: 1 } });
          await tx.generalTurn.update({
            where: { worldId_generalId_slot: { worldId, generalId: 3, slot: 0 } },
            data: { commandKey: 'move', args: { cityKey: 2 }, explicit: true },
          });
        }
        await tx.world.update({
          where: { id: worldId },
          data: { lineageState: lineage as unknown as Prisma.InputJsonValue },
        });
        if (scenario.includes('upgrade') || scenario.includes('shrink')) {
          await tx.nation.update({ where: { worldId_id: { worldId, id: 1 } }, data: { gold: 1000000 } });
          await tx.general.updateMany({ where: { worldId }, data: { nextTurnTick: 20000 } });
          await tx.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { nextTurnTick: 9999 } });
          await tx.world.update({
            where: { id: worldId },
            data: {
              preparedTurnsState: {
                version: 1,
                nations: { 1: { 12: { commandKey: 'nation_expand', args: { cityKey: 1 }, term: 4, cityLevel: 2 } } },
              },
            },
          });
          await tx.nationOfficeTurn.upsert({
            where: { worldId_nationId_officerLevel_slot: { worldId, nationId: 1, officerLevel: 12, slot: 0 } },
            create: {
              worldId,
              nationId: 1,
              officerLevel: 12,
              slot: 0,
              commandKey: 'nation_expand',
              args: { cityKey: 1 },
            },
            update: { commandKey: 'nation_expand', args: { cityKey: 1 } },
          });
          await tx.world.update({
            where: { id: worldId },
            data: { campaignState: setup.state.campaign as unknown as Prisma.InputJsonValue },
          });
          await tx.generalTurn.update({
            where: { worldId_generalId_slot: { worldId, generalId: 2, slot: 0 } },
            data: { commandKey: 'build', args: { slotId: '-1,-1', building: 'farm' }, explicit: true },
          });
          if (scenario.startsWith('succession'))
            await tx.generalTurn.update({
              where: { worldId_generalId_slot: { worldId, generalId: 1, slot: 0 } },
              data: { commandKey: 'build', args: { slotId: '-1,-1', building: 'farm' }, explicit: true },
            });
          await tx.generalTurn.update({
            where: { worldId_generalId_slot: { worldId, generalId: 2, slot: 1 } },
            data: { commandKey: 'return', args: {}, explicit: true },
          });
          await tx.generalTurn.update({
            where: { worldId_generalId_slot: { worldId, generalId: 2, slot: 2 } },
            data: { commandKey: 'demolish', args: { slotId: '0,0' }, explicit: true },
          });
        }
        for (const resizing of scenario.includes('shrink')
          ? ['nation_expand', 'nation_shrink']
          : scenario.includes('upgrade')
            ? ['nation_expand']
            : []) {
          if (resizing === 'nation_shrink') {
            await tx.world.update({
              where: { id: worldId },
              data: {
                preparedTurnsState: {
                  version: 1,
                  nations: { 1: { 12: { commandKey: resizing, args: { cityKey: 1 }, term: 4, cityLevel: 5 } } },
                },
              },
            });
            await tx.nationOfficeTurn.update({
              where: { worldId_nationId_officerLevel_slot: { worldId, nationId: 1, officerLevel: 12, slot: 0 } },
              data: { commandKey: resizing, args: { cityKey: 1 } },
            });
            await tx.general.update({ where: { worldId_id: { worldId, id: 1 } }, data: { nextTurnTick: 9999 } });
          }
          const beforeTurn = await loadReplayState(tx, worldId);
          const expectedTurn = runReplayAction(beforeTurn, initial.seed, initial.unitSet);
          const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
          const slots = await tx.generalTurn.findMany({ where: { worldId, generalId: 1 }, orderBy: { slot: 'asc' } });
          const turn = runGeneralTurn(
            beforeTurn.state,
            { generalId: 1, tick: 9999, unitSet: initial.unitSet },
            beforeTurn.turns[1]![0]!,
            initial.seed,
            { turnRevision: actor.turnRevision, policy: beforeTurn.policy!.policies[1]! },
            resolverForRuleFeatures(beforeTurn.state),
            { offices: beforeTurn.offices! },
          );
          expect(turn.nation?.commandKey).toBe(resizing);
          if (!turn.nation || 'code' in turn.nation.result || !turn.nation.result.cityResize)
            throw Error('증축 실행이 필요합니다.');
          await persistCityLandTurns(tx, worldId, beforeTurn.state, turn.nation.result.cityResize, actor, slots);
          turn.state.generals[1]!.nextTurnTick += TICKS_PER_MONTH;
          const packet = completePersonnelStep(
            beforeTurn.state,
            beforeTurn.offices!,
            { state: turn.state, ...turn.personnel! },
            9999,
          );
          const anchors = updateResidenceAnchors({
            before: beforeTurn.state,
            after: packet.state,
            anchors: beforeTurn.residenceAnchors!,
            tick: 9999,
            createdHumanId: null,
          });
          await persistEffects(
            tx,
            worldId,
            packet.state,
            [{ kind: 'world', state: packet.state }],
            { sequence: 1, tick: 9999 },
            beforeTurn.state,
            () => persistPersonnelPacket(tx, worldId, beforeTurn, packet, anchors, { sequence: 1, tick: 9999 }),
          );
          await appendReputationEvents(
            tx,
            worldId,
            reputationTurnEvents({
              before: beforeTurn.state,
              after: packet.state,
              generalId: 1,
              tick: 9999,
              commandKey: turn.commandKey,
              result: turn.result,
            }),
          );
          await shiftTurns(tx, worldId, 1, undefined, slots);
          await tx.general.update({
            where: { worldId_id: { worldId, id: 1 } },
            data: { turnRevision: actor.turnRevision + 1, nextTurnTick: 19999 },
          });
          const actualTurn = await loadReplayState(tx, worldId);
          expect(actualTurn).toEqual(expectedTurn);
          expect(hashState(actualTurn)).toBe(hashState(expectedTurn));
          if (scenario.startsWith('null-state')) {
            expect(expectedTurn.state.cities[1]).not.toHaveProperty('parentCityKey');
            expect(actualTurn.state.cities[1]).not.toHaveProperty('parentCityKey');
          }
        }
        const before = await loadReplayState(tx, worldId);
        const expected = settleReplayMonth(before, initial.seed, 10000).replay;
        if (scenario.startsWith('birth')) expect(Object.keys(expected.state.generals)).toHaveLength(4);
        if (scenario.startsWith('succession')) {
          expect(expected.state.lineage!.persons['1']!.successorId).toBe(3);
          expect(expected.turns[3]![0]!.commandKey).toBe('rest');
        }
        await persistMonthly(tx, worldId, initial.seed, 10000, 1);
        const actual = await loadReplayState(tx, worldId);
        if (scenario.includes('upgrade') || scenario.includes('shrink')) {
          expect(actual.state.cities[1]).toMatchObject({
            level: scenario.includes('shrink') ? 2 : 5,
          });
          if (scenario.startsWith('null-state')) expect(actual.state.cities[1]).not.toHaveProperty('parentCityKey');
          else expect(actual.state.cities[1]!.parentCityKey).toBeNull();
          expect(
            (await tx.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 1 } } })).parentCityKey,
          ).toBeNull();
          expect(actual.turns[2]![0]).toMatchObject({
            commandKey: 'build',
            args: { slotId: scenario.includes('shrink') ? '-1,-1' : '-0.5,-0.5' },
          });
          expect(actual.turns[2]![2]).toEqual(before.turns[2]![2]);
        }
        expect(actual).toEqual(expected);
        expect(hashState(actual)).toBe(hashState(expected));
        expect(
          (await tx.yearbookSnapshot.findUniqueOrThrow({ where: { worldId_tick: { worldId, tick: 10000 } } }))
            .stateHash,
        ).toBe(hashState(expected));
        throw rollback;
      },
      { timeout: 30000 },
    ),
  ).rejects.toBe(rollback);
});
