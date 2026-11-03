import type { StratagemCardsConfig } from './config';

// 비공개 시험값이다. 공개 생성 선택지·프로필에서 읽지 않는다.
export const TEST_STRATAGEM_CARDS_CONFIG: StratagemCardsConfig = {
  version: 1,
  capacity: 3,
  deck: [
    { kind: 'fire_attack', weight: 1 },
    { kind: 'sabotage', weight: 1 },
    { kind: 'incite', weight: 1 },
    { kind: 'plunder', weight: 1 },
    { kind: 'trap', weight: 1 },
  ],
  trapCountsInCapacity: true,
  trap: { lossBp: 2000, atmosLoss: 10 },
  campaignLoss: 'eligibleAll',
  consumeOnRollFailure: true,
  checkOnReserve: false,
  setter: 'ruler',
  zeroForce: 'cancel',
  startHand: 0,
  trapExpiryMonths: null,
};
