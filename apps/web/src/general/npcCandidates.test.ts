import { describe, expect, it } from 'vitest';
import { candidateStats, sortByStatTotal, statTotal } from './npcCandidates';

// NPC 무장 맡기 후보의 능력치 칸과 순서 (INT-26, p8-personnel-3).
describe('NPC 후보 능력치', () => {
  const three = { generalId: 3, leadership: 70, strength: 80, intel: 60 };
  const five = { generalId: 5, leadership: 70, strength: 80, intel: 60, politics: 50, charm: 40 };

  it('3능력치 월드는 통솔·무력·지력 세 칸, 5능력치 월드는 정치·매력까지 다섯 칸이다', () => {
    expect(candidateStats(three).map((cell) => `${cell.label} ${cell.value}`)).toEqual([
      '통솔 70',
      '무력 80',
      '지력 60',
    ]);
    expect(candidateStats(five).map((cell) => `${cell.label} ${cell.value}`)).toEqual([
      '통솔 70',
      '무력 80',
      '지력 60',
      '정치 50',
      '매력 40',
    ]);
    expect(statTotal(three)).toBe(210);
    expect(statTotal(five)).toBe(300);
  });

  it('능력치 합이 큰 순으로 두고 같으면 장수 번호 순이다. 원래 배열은 바꾸지 않는다', () => {
    const list = [
      { generalId: 9, leadership: 50, strength: 50, intel: 50 },
      { generalId: 2, leadership: 90, strength: 90, intel: 90 },
      { generalId: 4, leadership: 60, strength: 40, intel: 40 },
      { generalId: 1, leadership: 50, strength: 50, intel: 50 },
    ];
    expect(sortByStatTotal(list).map((general) => general.generalId)).toEqual([2, 1, 9, 4]);
    expect(list.map((general) => general.generalId)).toEqual([9, 2, 4, 1]);
  });
});
