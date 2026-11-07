import { readHistoricEventsConfig, type HistoricEventsConfig } from './state';

const emperorChronicle = 'https://zh.wikisource.org/wiki/後漢書/卷9#建安';
const goldCost = { kind: 'gold', value: -1_000 } as const;
const goldGain = { kind: 'gold', value: 1_000 } as const;
const riceCost = { kind: 'rice', value: -1_000 } as const;
const riceGain = { kind: 'rice', value: 1_000 } as const;
const moraleGain = { kind: 'atmos', value: 5 } as const;
const moraleLoss = { kind: 'atmos', value: -5 } as const;
const pact = { kind: 'nonAggression', months: 3 } as const;

const config: HistoricEventsConfig = {
  windowMonths: 2,
  events: [
    {
      id: 'E1',
      year: 194,
      month: 1,
      chooser: { nationId: 12, name: '도겸' },
      counterpart: { nationId: 13, name: '유비' },
      title: '도겸의 부탁',
      text: '병이 깊어진 도겸이 서주를 맡길 사람으로 유비를 떠올립니다.',
      options: [
        { label: '유비에게 뒤를 부탁한다', effects: [pact, goldCost] },
        { label: '가문에 맡긴다', effects: [riceGain] },
      ],
      defaultOption: 1,
      ref: 'https://zh.wikisource.org/wiki/三國志/卷32',
    },
    {
      id: 'E2',
      year: 196,
      month: 8,
      chooser: { nationId: 1, name: '조조' },
      counterpart: { nationId: 5, name: '이각' },
      title: '천자를 맞을까',
      text: '낙양의 천자가 머물 곳을 찾고 있습니다.',
      options: [
        { label: '천자를 허로 모신다', effects: [goldCost, moraleGain] },
        { label: '근거지부터 다진다', effects: [riceGain] },
      ],
      defaultOption: 1,
      ref: emperorChronicle,
    },
    {
      id: 'E3',
      year: 197,
      month: 1,
      chooser: { nationId: 6, name: '원술' },
      counterpart: null,
      title: '황제의 칭호',
      text: '하내 사람 장형이 올린 부명을 들어 황제를 칭하자는 말이 나옵니다.',
      options: [
        { label: '황제를 칭한다', effects: [goldGain, moraleLoss] },
        { label: '칭호를 미룬다', effects: [moraleGain] },
      ],
      defaultOption: 1,
      ref: emperorChronicle,
    },
    {
      id: 'E4',
      year: 198,
      month: 12,
      chooser: { nationId: 8, name: '여포' },
      counterpart: { nationId: 1, name: '조조' },
      title: '서주 공방',
      text: '조조의 군대가 서주로 밀려왔습니다.',
      options: [
        { label: '성을 지킨다', effects: [riceCost, moraleGain] },
        { label: '화친을 청한다', effects: [pact, goldCost] },
      ],
      defaultOption: 0,
      ref: emperorChronicle,
    },
    {
      id: 'E5',
      year: 199,
      month: 3,
      chooser: { nationId: 10, name: '공손찬' },
      counterpart: { nationId: 2, name: '원소' },
      title: '역경 공방',
      text: '원소의 군대가 역경 아래까지 들어왔습니다.',
      options: [
        { label: '역경에서 버틴다', effects: [riceCost, moraleGain] },
        { label: '화친을 청한다', effects: [pact, goldCost] },
      ],
      defaultOption: 0,
      ref: emperorChronicle,
    },
    {
      id: 'E6',
      year: 200,
      month: 9,
      chooser: { nationId: 1, name: '조조' },
      counterpart: { nationId: 2, name: '원소' },
      title: '관도의 대치',
      text: '관도에서 원소와 맞선 지 여러 달이 지났습니다. 허로 물러나자는 말이 나옵니다.',
      options: [
        { label: '물러나지 않는다', effects: [riceCost, moraleGain] },
        { label: '허로 물러난다', effects: [riceGain, moraleLoss] },
      ],
      defaultOption: 0,
      ref: emperorChronicle,
    },
    {
      id: 'E7',
      year: 207,
      month: 1,
      chooser: { nationId: 13, name: '유비' },
      counterpart: null,
      title: '융중의 선비',
      text: '서서가 융중에 사는 제갈량을 직접 찾아가라고 권합니다.',
      options: [
        { label: '세 번 찾아간다', effects: [goldCost, moraleGain] },
        { label: '사람을 보내 부른다', effects: [] },
      ],
      defaultOption: 1,
      ref: 'https://zh.wikisource.org/wiki/三國志/卷35',
    },
    {
      id: 'E8',
      year: 208,
      month: 10,
      chooser: { nationId: 9, name: '손책' },
      counterpart: { nationId: 1, name: '조조' },
      title: '적벽',
      text: '조조가 수군을 이끌고 장강을 따라 내려옵니다.',
      options: [
        { label: '맞서 싸운다', effects: [riceCost, moraleGain] },
        { label: '화친을 논한다', effects: [pact, goldCost] },
      ],
      defaultOption: 0,
      ref: emperorChronicle,
    },
  ],
};

export function createHistoricEvents1030(
  initial: Parameters<typeof readHistoricEventsConfig>[0] & { scenarioKey: string },
) {
  if (initial.scenarioKey !== '1030') throw new Error('역사 사건은 1030 시나리오에서만 사용할 수 있습니다.');
  return readHistoricEventsConfig(initial, config);
}
