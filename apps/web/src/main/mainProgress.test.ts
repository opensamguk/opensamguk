import { describe, expect, it } from 'vitest';
import { seasonOf, settingTags } from './mainProgress';

describe('INT-25 AC-INT-25 메인 진행 정보 줄', () => {
  it('달마다 계절 글자를 정한다', () => {
    expect([1, 3, 4, 6, 7, 9, 10, 12].map(seasonOf)).toEqual([
      '봄',
      '봄',
      '여름',
      '여름',
      '가을',
      '가을',
      '겨울',
      '겨울',
    ]);
    expect(seasonOf(0)).toBeNull();
    expect(seasonOf(13)).toBeNull();
  });

  it('켜진 서버 설정만 딱지로 쓰고 응답이 없으면 뺀다', () => {
    expect(settingTags({})).toEqual([]);
    expect(settingTags({ truce: null, generalCreationEnabled: true })).toEqual([]);
    expect(
      settingTags({ truce: { startMinute: 120, endMinute: 360 }, generalCreationEnabled: false, npcPlayEnabled: true }),
    ).toEqual(['야간 휴전', '장수 생성 닫힘', 'NPC 맡기 허용']);
  });
});
