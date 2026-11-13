import { describe, expect, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';
import { commandWorld } from '../../test/commandFixture';
import { runGeneralTurn } from './turn';
import { riceMarketRate } from '../world/riceMarket';

describe('trade_rice', () => {
  it('성공', () => verifySuccess('trade_rice'));
  it('실패', () => verifyFailure('trade_rice'));
  it('시세가 켜진 월드에서 상인 유무·실제 교환·국고 수수료를 같은 턴에서 처리한다', () => {
    const state = commandWorld();
    state.ruleFeatures = ['rice-market-v1'];
    const general = state.generals[1]!;
    const city = state.cities[general.cityKey]!;
    const actor = { generalId: general.id, tick: 100 };
    const command = { commandKey: 'trade_rice', args: { amount: 1_000, buy: true } };
    city.level = 3;
    expect(runGeneralTurn(state, actor, command, 'rice-market').result).toMatchObject({ code: 'BAD_STATE' });
    city.level = 8;
    const rate = riceMarketRate('rice-market', actor.tick, city)!;
    const before = { gold: general.gold, rice: general.rice, treasury: state.nations[general.nationId!]!.gold };
    const result = runGeneralTurn(state, actor, command, 'rice-market');
    expect(result.result).toHaveProperty('logs');
    expect(result.state.generals[general.id]).toMatchObject({
      rice: before.rice + 1_000,
      gold: before.gold - Math.round(rate * 10 * 1.01),
    });
    expect(result.state.nations[general.nationId!]!.gold).toBe(before.treasury + Math.floor(rate / 10));
  });
});
