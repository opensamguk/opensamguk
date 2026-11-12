import { BALANCE } from '../balance';
import { STRATAGEM } from './ext/stratagem/base';
import { INTEL } from './ext/intel/base';
import { nationResearchSpecs } from '../nationResearch/commands';
import { DOMESTIC_SPECS } from './domestic/investment';

interface PlayerDoc {
  summary: string;
  requires: readonly string[];
  cost: string | null;
}

const ownCity = '보급이 이어진 자기 국가 도시';
const authorized = '국가 예턴에서 해당 명령을 쓸 권한';
const recruit = [ownCity, '모집 가능한 병종과 충분한 인구', '지휘 병력 상한 이내'];
const recruitCost = '모집 인원과 병종에 따른 금, 모집 인원만큼의 도시 인구';
const foundation = ['재야 장수', '소유국이 없는 도시', '건국 보호 기간이 끝난 뒤', '쓰이지 않은 나라 이름'];
const stratagem = ['계략을 쓸 수 있는 월드', ownCity, '불가침 중이 아닌 다른 국가의 도시'];
const stratagemCost = `금 ${STRATAGEM.COST_GOLD}, 쌀 ${STRATAGEM.COST_RICE}`;
const domesticSummary: Readonly<Record<string, string>> = {
  farm: '도시의 농업을 높입니다.',
  commerce: '도시의 상업을 높입니다.',
  security: '도시의 치안을 높입니다.',
  settle: '도시의 인구를 늘립니다.',
  goodwill: '도시의 민심을 높입니다.',
  defence: '도시의 수비를 강화합니다.',
  wall: '도시의 성벽을 보수합니다.',
  research: '국가의 기술을 높입니다.',
};

// 화면 설명은 명령 키에 붙인다. 카탈로그가 등록부와 설명의 누락·잔여를 함께 검사한다.
export const commandPlayerDocs: Readonly<Record<string, PlayerDoc>> = {
  ...Object.fromEntries(
    DOMESTIC_SPECS.map((spec) => {
      const summary = domesticSummary[spec.key];
      if (!summary) throw new Error(`내정 명령 도움말이 없습니다: ${spec.key}`);
      const construction = spec.field === 'defence' || spec.field === 'wall';
      return [
        spec.key,
        {
          summary,
          requires: [ownCity, '수치가 최대치 미만', ...(construction ? [] : ['도시에서 실행'])],
          cost: `금 ${BALANCE.DEVEL_COST * (spec.costFactor ?? 1)}${construction ? ', 물류 월드에서는 건설 자원 추가' : ''}`,
        },
      ];
    }),
  ),
  rest: { summary: '이번 장수 턴에 쉽니다.', requires: [], cost: null },
  recruit: { summary: '병사를 모집합니다.', requires: recruit, cost: recruitCost },
  conscript: {
    summary: '민심을 낮추는 대신 병사를 더 적은 금으로 모집합니다.',
    requires: recruit,
    cost: `${recruitCost}, 민심 감소`,
  },
  train: {
    summary: '병력의 훈련도를 높입니다.',
    requires: [ownCity, '병력이 있고 훈련도가 최대치 미만'],
    cost: `금 ${BALANCE.DRILL_COST}`,
  },
  morale: {
    summary: '병력의 사기를 높입니다.',
    requires: [ownCity, '병력이 있고 사기가 최대치 미만'],
    cost: `금 ${BALANCE.DRILL_COST}`,
  },
  move: {
    summary: '연결된 도시로 장수를 이동시킵니다.',
    requires: ['연결된 도시', '소속 장수는 자기 국가나 공백 도시로 이동'],
    cost: null,
  },
  return: {
    summary: '자기 국가의 수도로 돌아갑니다.',
    requires: ['국가 소속', '돌아갈 수도가 있고 현재 위치가 수도 밖'],
    cost: null,
  },
  dismiss: { summary: '병력을 해산하고 소속 도시에서는 인구로 돌려보냅니다.', requires: ['해산할 병력'], cost: null },
  attack: {
    summary: '인접한 거점에 출병해 전투하고 이기면 점령합니다.',
    requires: [ownCity, '출병할 병력과 사기', '보호 기간이 끝난 뒤', '공백지 또는 교전 중인 국가의 인접 거점'],
    cost: '전투 군량과 피해 병력',
  },
  join: {
    summary: '선택한 국가에 들어가 수도로 이동합니다.',
    requires: ['재야 장수', '임관 가능한 국가와 그 수도'],
    cost: null,
  },
  join_random: {
    summary: '임관 가능한 국가 가운데 한 곳에 들어갑니다.',
    requires: ['재야 장수', '임관 가능한 국가가 하나 이상'],
    cost: null,
  },
  found: {
    summary: '현재 도시에 새 나라를 세우고 군주가 됩니다.',
    requires: foundation,
    cost: `금 ${BALANCE.FOUND_COST}`,
  },
  uprising: {
    summary: '병력을 이끌고 현재 도시에 새 나라를 세웁니다.',
    requires: [...foundation, '거병할 병력'],
    cost: `금 ${BALANCE.FOUND_COST}`,
  },
  resign: { summary: '현재 국가에서 나와 재야가 됩니다.', requires: ['국가 소속'], cost: null },
  invite: {
    summary: '재야 장수에게 우리 나라 임관을 제안합니다.',
    requires: ['군주', '등용 가능한 재야 장수'],
    cost: null,
  },
  accept_invite: {
    summary: '등용 제안을 수락하고 그 나라에 들어갑니다.',
    requires: ['재야 장수', '수락할 수 있는 등용 제안'],
    cost: null,
  },
  heal: { summary: '장수의 부상을 회복합니다.', requires: ['부상 있음'], cost: `금 ${BALANCE.HEAL_COST}` },
  trade_rice: {
    summary: '개인 금으로 쌀을 사거나 개인 쌀을 팝니다.',
    requires: [ownCity, '거래할 금이나 쌀'],
    cost: '거래 수량만큼의 금 또는 쌀',
  },
  donate: {
    summary: '개인 자원을 국고에 넣어 공헌을 쌓습니다.',
    requires: ['국가 소속', '헌납할 자원'],
    cost: '헌납 수량만큼의 금 또는 쌀',
  },
  nation_rest: { summary: '이번 국가 예턴 칸에서 쉽니다.', requires: [authorized], cost: null },
  nation_reward: {
    summary: '국고에서 같은 국가 장수에게 자원을 줍니다.',
    requires: [authorized, '국고에 줄 자원이 있음'],
    cost: '국고에서 지급할 금 또는 쌀',
  },
  nation_seize: {
    summary: '같은 국가 장수의 자원을 걷어 국고로 옮깁니다.',
    requires: [authorized, '대상 장수에게 걷을 자원이 있음'],
    cost: '대상 장수에게서 걷을 금 또는 쌀',
  },
  nation_assign: {
    summary: '같은 국가 장수를 자기 국가 도시로 발령합니다.',
    requires: [authorized, '소속 장수와 자기 국가 도시'],
    cost: null,
  },
  nation_capital: {
    summary: '수도를 자기 국가의 다른 도시로 옮깁니다.',
    requires: [authorized, '현재 수도가 아닌 자기 국가 도시'],
    cost: null,
  },
  nation_declare: {
    summary: '중립 국가에 선전포고합니다.',
    requires: [authorized, '보호 기간이 끝난 뒤', '중립인 다른 국가'],
    cost: null,
  },
  nation_peace: {
    summary: '교전 중인 국가에 종전을 제안합니다.',
    requires: [authorized, '교전 중인 다른 국가'],
    cost: null,
  },
  nation_pact: { summary: '중립 국가에 불가침을 제안합니다.', requires: [authorized, '중립인 다른 국가'], cost: null },
  nation_break_pact: {
    summary: '불가침 중인 국가에 협정 파기를 제안합니다.',
    requires: [authorized, '불가침 중인 다른 국가'],
    cost: null,
  },
  nation_aid: {
    summary: '다른 나라에 국고 자원 원조를 제안합니다.',
    requires: [authorized, '교전 또는 선전포고 중이 아닌 다른 국가', '원조할 국고 자원'],
    cost: '국고에서 보내는 금 또는 쌀',
  },
  trade: {
    summary: '인접 도시와 교역해 국고 금·쌀을 늘리고 우리 도시의 상업과 농업을 높입니다.',
    requires: ['조약 교역 기능을 켠 월드', '자기 국가 도시', '교전 중이 아닌 상대 도시와 유효한 교역 조약'],
    cost: null,
  },
  spy: {
    summary: '대상 도시의 정보를 얻습니다. 가까운 도시일수록 더 자세히 확인합니다.',
    requires: ['첩보 기능을 켠 월드', '국가 소속', '자기 국가 밖의 도시'],
    cost: `금 ${INTEL.COST_GOLD}, 쌀 ${INTEL.COST_RICE}`,
  },
  equipment_trade: {
    summary: '장비를 사서 착용하거나 선택한 칸의 장비를 팝니다.',
    requires: ['장비와 물류 기능을 켠 월드', ownCity, '구매는 장비별 치안과 재료, 판매는 해당 칸에 장착한 장비'],
    cost: '구매할 장비의 금과 도시 재료',
  },
  abdicate: {
    summary: '같은 국가의 다른 장수에게 군주 자리를 넘깁니다.',
    requires: ['국가 변천 기능을 켠 월드', '군주', '이미 등장한 같은 국가 장수'],
    cost: null,
  },
  wander: {
    summary: '보유 도시를 놓고 소속 장수와 방랑을 시작합니다.',
    requires: ['국가 변천 기능을 켠 월드', '군주', '보호 기간이 끝나고 전쟁이나 선포가 없는 국가'],
    cost: '보유 도시',
  },
  resettle: {
    summary: '방랑을 끝내고 현재 도시를 새 수도로 삼습니다.',
    requires: ['국가 변천 기능을 켠 월드', '방랑 국가의 군주', '소속 장수 두 명 이상', '소·중 규모의 빈 도시'],
    cost: null,
  },
  disband: {
    summary: '방랑 국가를 해산하고 소속 장수를 재야로 돌려보냅니다.',
    requires: ['국가 변천 기능을 켠 월드', '방랑 국가의 군주', '월드 시작 다음 달부터'],
    cost: null,
  },
  nation_mobilize: {
    summary: '자기 국가 도시의 수비와 성벽을 최대치의 80%까지 복구합니다.',
    requires: ['국가 전략 기능을 켠 월드', '군주·참모·수뇌', '전략 재사용 대기 종료'],
    cost: null,
  },
  nation_rivalry: {
    summary: '적국과의 관계를 선전포고 상태로 두고 교전 시작을 한 달 늦춥니다.',
    requires: [
      '국가 전략 기능을 켠 월드',
      '군주 또는 참모',
      '선전포고 중이거나 교전 중인 상대',
      '전략 재사용 대기 종료',
    ],
    cost: null,
  },
  nation_raid: {
    summary: '선전포고 대기 기간을 즉시 끝냅니다.',
    requires: [
      '국가 전략 기능을 켠 월드',
      '군주 또는 참모',
      '상대와의 선전포고 기간 한 달 이상',
      '전략 재사용 대기 종료',
    ],
    cost: null,
  },
  form_unit: {
    summary: '선택한 병종으로 병력이 없는 새 부곡을 편성합니다.',
    requires: ['도시 자원 기능을 켠 월드', ownCity, '편성할 수 있는 병종과 같은 병종의 빈 부곡 없음'],
    cost: null,
  },
  nation_city_allocate: {
    summary: '도시 수비병을 같은 병종의 부곡으로 옮깁니다.',
    requires: [
      '도시 자원 기능을 켠 월드',
      '군주·참모·수뇌',
      '부곡 소유자와 지휘관이 대상 도시에 집결',
      '도시 병력과 지휘 한도',
    ],
    cost: '배속 수량만큼의 도시 수비병',
  },
  ...Object.fromEntries(
    nationResearchSpecs.map(({ key, name, turns, cost }) => [
      key,
      {
        summary: `${name}를 완료해 국가의 특수 병종을 해금합니다.`,
        requires: [
          '특수 병종 연구 기능을 켠 월드',
          '자기 국가 도시의 군주·참모·수뇌',
          '완료 이력이 없는 연구',
          `준비를 포함한 ${turns}턴`,
        ],
        cost: `국고 금 ${cost}, 쌀 ${cost}`,
      },
    ]),
  ),
  fire_attack: { summary: '화계로 대상 도시의 시설에 피해를 줍니다.', requires: stratagem, cost: stratagemCost },
  sabotage: { summary: '대상 도시의 수비 시설을 파괴합니다.', requires: stratagem, cost: stratagemCost },
  incite: { summary: '대상 도시의 주민을 선동해 민심을 떨어뜨립니다.', requires: stratagem, cost: stratagemCost },
  plunder: { summary: '대상 도시를 통해 상대 국고의 금과 쌀을 탈취합니다.', requires: stratagem, cost: stratagemCost },
};
