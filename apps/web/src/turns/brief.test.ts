import { describe, expect, it } from 'vitest';
import { particle } from '../game/josa';
import { withTargets, type ArgNames } from './args';
import { reservedBrief } from './brief';

// 원작 core2026 test/reservedCommandBrief.test.ts의 사례 가운데 우리 명령에 있는 것을 옮긴다.
// 원작의 도시·국가·장수 보기(단양·업, 오·위, 손권·조조)를 그대로 쓴다.
const names: ArgNames = {
  city: (key) => ({ 2: '단양', 3: '업', 4: '낙양', 5: '신야' })[key],
  nation: (id) => ({ 2: '오', 3: '위', 4: '원소' })[id],
  general: (id) => ({ 8: '손권', 9: '조조(曹操)', 10: '여포NPC', 11: '장비', 12: '서서' })[id],
  unit: (id) => ({ 1100: '보병', 1200: '정예병', 1300: '창병' })[id],
  equipment: (key) => ({ weapon_01: '단도', horse_01: '노기(+1)' })[key],
};
const brief = (key: string, args: Record<string, unknown>, name?: string) => reservedBrief(key, args, names, name);

describe('INT-25 INT-26 AC-INT-26 원작 예턴 요약', () => {
  it('출병·계략·모병을 실제 인자 요약으로 적는다', () => {
    expect(brief('attack', { cityKey: 2 })).toBe('【단양】으로 출병');
    expect(brief('fire_attack', { cityKey: 3 }, '화계')).toBe('【업】에 화계실행');
    expect(brief('incite', { cityKey: 2 }, '선동')).toBe('【단양】에 선동실행');
    expect(brief('recruit', { crewType: 1100, amount: 2400 })).toBe('【보병】 2400명 모병');
    expect(brief('recruit', { crewType: 1200, amount: 2500 })).toBe('【정예병】 2500명 모병');
    expect(brief('recruit', { crewType: 1300, amount: 1000 })).toBe('【창병】 1000명 모병');
  });

  it('개인 명령의 원작 요약 변형을 지킨다', () => {
    const cases: Array<[string, Record<string, unknown>, string, string?]> = [
      ['move', { cityKey: 3 }, '【업】으로 이동'],
      ['move', { cityKey: 4 }, '【낙양】으로 이동'],
      ['spy', { cityKey: 2 }, '【단양】에 첩보 실행', '첩보'],
      ['sabotage', { cityKey: 3 }, '【업】에 파괴실행', '파괴'],
      ['plunder', { cityKey: 3 }, '【업】에 탈취실행', '탈취'],
      ['join', { nationId: 2 }, '【오】로 임관'],
      ['invite', { generalId: 9 }, '【조조】를 등용'],
      ['invite', { generalId: 8 }, '【손권】을 등용'],
      ['abdicate', { generalId: 8 }, '【손권】에게 선양', '선양'],
      ['join_random', {}, '무작위 국가로 임관'],
      ['found', { name: '촉한', color: '#123456' }, '【촉한】을 건국'],
      ['found', { name: '위', color: '#123456' }, '【위】를 건국'],
      ['trade_rice', { amount: 500, buy: true }, '군량 500을 구입'],
      ['trade_rice', { amount: 500, buy: false }, '군량 500을 판매'],
      ['donate', { amount: 300, resource: 'rice' }, '쌀 300을 헌납'],
      ['donate', { amount: 1000, resource: 'gold' }, '금 1000을 헌납'],
      ['conscript', { crewType: 1100, amount: 3200 }, '【보병】 3200명 징병'],
      ['equipment_trade', { slot: 'horse', itemKey: 'none' }, '【명마】를 판매.', '장비매매'],
      ['equipment_trade', { slot: 'weapon', itemKey: 'none' }, '【무기】를 판매.', '장비매매'],
      ['equipment_trade', { slot: 'book', itemKey: 'none' }, '【서적】을 판매.', '장비매매'],
      ['equipment_trade', { slot: 'weapon', itemKey: 'weapon_01' }, '【단도】를 구입', '장비매매'],
      ['equipment_trade', { slot: 'horse', itemKey: 'horse_01' }, '【노기(+1)】를 구입', '장비매매'],
    ];
    for (const [key, args, expected, name] of cases) expect(brief(key, args, name), key).toBe(expected);
  });

  it('국가 명령의 도시·국가·장수·자원 인자를 원작 요약으로 적는다', () => {
    const cases: Array<[string, Record<string, unknown>, string, string?]> = [
      ['nation_assign', { generalId: 8, cityKey: 3 }, '【손권】【업】으로 발령'],
      ['nation_assign', { generalId: 11, cityKey: 5 }, '【장비】【신야】로 발령'],
      ['nation_reward', { generalId: 8, amount: 12000, resource: 'gold' }, '【손권】 금 12,000 포상'],
      ['nation_seize', { generalId: 9, amount: 3400, resource: 'rice' }, '【조조】 쌀 3,400 몰수'],
      ['nation_reward', { generalId: 10, amount: 300, resource: 'rice' }, '【여포NPC】 쌀 300 포상'],
      ['nation_aid', { nationId: 2, amount: 12000, resource: 'gold' }, '【오】에게 국고 12,000 원조'],
      ['nation_aid', { nationId: 2, amount: 34000, resource: 'rice' }, '【오】에게 병량 34,000 원조'],
      ['nation_pact', { nationId: 2 }, '【오】에게 불가침 제의'],
      ['nation_break_pact', { nationId: 2 }, '【오】에게 불가침 파기 제의'],
      ['nation_peace', { nationId: 3 }, '【위】에게 종전 제의'],
      ['nation_declare', { nationId: 2 }, '【오】에 선전포고'],
      ['nation_declare', { nationId: 4 }, '【원소】에 선전포고'],
      ['nation_raid', { nationId: 3 }, '【위】에 급습', '급습'],
      ['nation_rivalry', { nationId: 2 }, '【오】에 이호경식', '이호경식'],
      ['nation_capital', { cityKey: 2 }, '【단양】으로 천도'],
      ['nation_mobilize', { cityKey: 3 }, '【업】에 백성동원', '백성동원'],
    ];
    for (const [key, args, expected, name] of cases) expect(brief(key, args, name), key).toBe(expected);
  });

  it('원작에 요약 규칙이 없는 명령은 표시명을 그대로 쓴다', () => {
    expect(brief('rest', {})).toBe('휴식');
    expect(brief('train', {})).toBe('훈련');
    expect(brief('nation_rest', {})).toBe('휴식');
    expect(brief('nation_research_halberd', {}, '극병 연구')).toBe('극병 연구');
    // 서버 명령 목록의 이름을 넘기면 그 이름을 쓴다.
    expect(brief('farm', {}, '농지 개간')).toBe('농지 개간');
  });

  it('원작에 없는 우리 명령도 대상을 남긴다', () => {
    expect(brief('trade', { cityKey: 4 }, '교역')).toBe('【낙양】과 교역');
    expect(brief('uprising', { name: '의군', color: '#123456' })).toBe('【의군】으로 거병');
  });

  it('대상 이름을 모르면 번호 대체 글을 쓰고 칸의 대상 이름을 먼저 쓴다', () => {
    const none: ArgNames = { city: () => undefined, nation: () => undefined };
    expect(reservedBrief('move', { cityKey: 7 }, none)).toBe('【도시 7】로 이동');
    expect(reservedBrief('nation_declare', { nationId: 9 }, none)).toBe('【국가 9】에 선전포고');
    expect(reservedBrief('invite', { generalId: 7 }, none)).toBe('【장수 7】을 등용');
    expect(reservedBrief('recruit', { crewType: 4242, amount: 100 }, none)).toBe('【병종 4242】 100명 모병');
    expect(reservedBrief('recruit', { amount: 100 }, none)).toBe('100명 모병');
    expect(reservedBrief('equipment_trade', { slot: 'book', itemKey: 'book_02' }, none)).toBe(
      '【장비 book_02】를 구입',
    );
    const named = withTargets(none, { city: '허창', nation: '위', general: '서서(徐庶)' });
    expect(reservedBrief('move', { cityKey: 3 }, named)).toBe('【허창】으로 이동');
    expect(reservedBrief('nation_assign', { generalId: 12, cityKey: 3 }, named)).toBe('【서서】【허창】으로 발령');
    expect(reservedBrief('invite', { generalId: 7 }, withTargets(none, { general: null }))).toBe('【장수 7】을 등용');
  });

  it('조사는 끝의 괄호 꼬리표를 빼고 고른다', () => {
    expect(particle('노기(+1)', '을/를')).toBe('를');
    expect(particle('조조(曹操)', '이/가')).toBe('가');
    expect(particle('남질', '으로/로')).toBe('로');
  });
});
