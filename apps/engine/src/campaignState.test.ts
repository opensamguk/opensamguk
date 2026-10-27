import type { Prisma } from '@opensamguk/db';
import {
  applyCampaignRelationship,
  emptyCampaignState,
  replayCampaignRelationship,
  toWorldState,
  type WorldState,
} from '@opensamguk/rules';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadInitialWorld } from './world/resources';
import { persistCampaignState, readCampaignArmyTypes, readStoredCampaign } from './campaignState';

let initial: Awaited<ReturnType<typeof monthlyFixture>>;
beforeAll(async () => {
  initial = await monthlyFixture();
});
function fixture() {
  const state = toWorldState(initial);
  state.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  for (const general of Object.values(state.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  state.campaign = emptyCampaignState(state, 'storage-test-seed', 'source-scenario');
  const execute = vi.fn().mockResolvedValue(1);
  const tx = { $executeRaw: execute } as unknown as Prisma.TransactionClient;
  return { state, execute, tx };
}

describe('AC-INT-06 휘하 저장 경계', () => {
  it('운영 병종을 생성 원장과 대조하고 사본 변조를 턴 처리 전에 거부한다', async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'immutable-army-source',
    });
    initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
    const origin = {
      version: 3,
      initial,
      initialStateHash: 'hash',
      resourceHash: 'hash',
      featureData: { policy: { version: 1, turnTermMinutes: 60 } },
    };
    const row = JSON.parse(JSON.stringify({ unitSet: initial.unitSet, replayOrigin: origin }));
    const types = readCampaignArmyTypes(row);
    expect(types).toContain(1100);
    expect(types).not.toContain(1000);
    row.unitSet.crewTypes[1].id = 9999;
    expect(() => readCampaignArmyTypes(row)).toThrow('생성 기록과 다릅니다');
    expect(
      readCampaignArmyTypes(JSON.parse(JSON.stringify({ unitSet: initial.unitSet, replayOrigin: origin }))),
    ).toEqual(types);
    expect(() => readCampaignArmyTypes({ unitSet: row.unitSet, replayOrigin: null })).toThrow();
  });
  it('꺼진 월드는 기존 병력을 보존하고 저장 상태가 없을 때만 허용한다', () => {
    const state = toWorldState(initial);
    state.generals[1]!.crew = 123;
    expect(readStoredCampaign(null, state, 'seed')).toBeUndefined();
    expect(() => readStoredCampaign({}, state, 'seed')).toThrow('끈 월드');
  });
  it.each(['missing', 'seed', 'duplicate', 'source'] as const)('%s 저장을 빈 상태로 보정하지 않는다', (kind) => {
    const f = fixture();
    if (kind === 'duplicate') f.state.generals[1]!.crew = 1;
    if (kind === 'source') delete f.state.campaign!.sources['1'];
    expect(() =>
      readStoredCampaign(
        kind === 'missing' ? null : f.state.campaign,
        f.state,
        kind === 'seed' ? 'other' : 'storage-test-seed',
      ),
    ).toThrow();
  });
  it('변경이 없으면 저장하지 않고 다른 월드·이전 값을 덮어쓰지 않는 바인딩 CAS를 쓴다', async () => {
    const f = fixture(),
      next = structuredClone(f.state);
    await persistCampaignState(f.tx, 'world-one', f.state, next);
    expect(f.execute).not.toHaveBeenCalled();
    next.campaign!.revision++;
    await persistCampaignState(f.tx, 'world-one', f.state, next);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const [sql, value, worldId, original] = f.execute.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      string,
      string,
      string,
    ];
    expect(sql.join('?')).toContain('WHERE id = ? AND "campaignState" = ?::jsonb');
    expect(worldId).toBe('world-one');
    expect(JSON.parse(value)).toEqual(next.campaign);
    expect(JSON.parse(original)).toEqual(f.state.campaign);
  });
  it('CAS 실패나 SQL 실패는 상위 트랜잭션으로 전파한다', async () => {
    const f = fixture(),
      next = structuredClone(f.state);
    next.campaign!.revision++;
    f.execute.mockResolvedValueOnce(0);
    await expect(persistCampaignState(f.tx, 'world-one', f.state, next)).rejects.toThrow('바뀌었습니다');
    f.execute.mockRejectedValueOnce(new Error('SQL failure'));
    await expect(persistCampaignState(f.tx, 'world-one', f.state, next)).rejects.toThrow('SQL failure');
  });
  it('typed 상태의 사람 제안→재생→CAS가 최신 관계 상태를 한 번 저장한다', async () => {
    const f = fixture();
    const [actor, target] = Object.values(f.state.generals).slice(0, 2);
    Object.assign(actor!, { userId: 'owner', nationId: 1, cityKey: 1 });
    Object.assign(target!, {
      userId: 'target',
      nationId: 1,
      officerLevel: 1,
      cityKey: 1,
      activeFromYear: f.state.startYear,
    });
    const payload = { type: 'offer', targetId: target!.id, relation: 'STAFF', revision: 0 };
    const applied = applyCampaignRelationship(f.state, payload, actor!.id, f.state.campaign, {
      tick: 0,
      userId: 'owner',
      userActive: true,
    });
    if (!applied.ok) throw new Error(applied.code);
    expect(applied.state.campaign).toEqual(applied.campaign);
    const replayed = replayCampaignRelationship(f.state, f.state.campaign, {
      kind: 'campaign.relationship',
      payload,
      sequence: 1,
      tick: 0,
      generalId: actor!.id,
      status: 'APPLIED',
      result: { ...applied.result, tick: 0 },
    });
    expect(replayed.state).toEqual(applied.state);
    await persistCampaignState(f.tx, 'world-one', f.state, replayed.state);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.execute.mock.calls[0]![1])).toEqual(replayed.campaign);
    expect(replayed.campaign.offers).toHaveLength(1);
  });
  it('기능을 추가·삭제하거나 중복 병력을 저장하는 경로는 SQL 전에 거부한다', async () => {
    const f = fixture(),
      next = structuredClone(f.state);
    delete next.campaign;
    await expect(persistCampaignState(f.tx, 'world-one', f.state, next)).rejects.toThrow();
    const broken: WorldState = { ...next };
    await expect(persistCampaignState(f.tx, 'world-one', broken, next)).rejects.toThrow('저장 상태');
    next.campaign = structuredClone(f.state.campaign!);
    next.generals[1]!.crew = 1;
    await expect(persistCampaignState(f.tx, 'world-one', f.state, next)).rejects.toThrow('중복 저장');
    expect(f.execute).not.toHaveBeenCalled();
  });
});
