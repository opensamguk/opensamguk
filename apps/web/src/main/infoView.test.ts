import { describe, expect, it } from 'vitest';
import {
  cityLevelText,
  garrisonSummary,
  nationHeads,
  nationTotals,
  nearMax,
  populationRate,
  readyArmy,
  techText,
  worldEvents,
} from './infoView';

// 원작 정보 칸 계산 (INT-25 3단계). 장수·도시·연감 값은 응답 모양의 시험 값이다.
const army = (crew: number, train: number, atmos: number) => ({ crew, train, atmos });

describe('국가·도시 칸 글자', () => {
  it('기술은 1000 단위 등급과 수치를 함께 쓴다', () => {
    expect(techText(5432.7)).toBe('5등급 / 5,432');
    expect(techText(999)).toBe('0등급 / 999');
    expect(techText(12000)).toBe('12등급 / 12,000');
  });

  it('규모는 이름과 숫자를 함께 쓰고 모르는 규모는 숫자만 쓴다', () => {
    expect(cityLevelText(8)).toBe('특(8)');
    expect(cityLevelText(0)).toBe('무(0)');
    expect(cityLevelText(12)).toBe('규모 12');
  });

  it('인구율은 소수 한 자리 백분율이다', () => {
    expect(populationRate(40_650, 100_000)).toBe('40.6%');
    expect(populationRate(1, 0)).toBe('—');
  });

  it('최대까지 1,000(수비·성벽 700) 안쪽만 남은 양을 알린다', () => {
    expect(
      nearMax([
        { label: '농업', value: 9_100, max: 10_000 },
        { label: '상업', value: 8_000, max: 10_000 },
        { label: '수비', value: 9_200, max: 10_000 },
        { label: '성벽', value: 9_400, max: 10_000 },
        { label: '치안', value: 10_000, max: 10_000 },
      ]),
    ).toEqual([
      { label: '농업', left: 900 },
      { label: '성벽', left: 600 },
    ]);
  });
});

describe('병력 합계', () => {
  it('훈련·사기가 모두 기준 이상이고 병력이 있는 장수만 센다', () => {
    const generals = [army(1000, 95, 90), army(2000, 90, 80), army(0, 100, 100), army(500, 60, 60)];
    expect(readyArmy(generals, 90)).toEqual({ troops: 1000, count: 1 });
    expect(readyArmy(generals, 60)).toEqual({ troops: 3500, count: 3 });
  });

  it('국가 합계는 금·쌀 평균과 통솔×100 최대 병력을 낸다', () => {
    const totals = nationTotals([
      { ...army(3000, 90, 90), leadership: 70, gold: 1000, rice: 500 },
      { ...army(0, 0, 0), leadership: 50, gold: 0, rice: 300 },
      // 부곡 월드는 지휘 병력을 쓴다.
      { ...army(0, 0, 0), commandedArmy: { troops: 800, train: 80, atmos: 85 }, leadership: 40, gold: 501, rice: 0 },
    ]);
    expect(totals).toMatchObject({
      count: 3,
      troops: 3800,
      maxTroops: 16_000,
      withTroops: 2,
      gold: 1501,
      averageGold: 500,
      averageRice: 267,
      ready90: { troops: 3000, count: 1 },
      ready80: { troops: 3800, count: 2 },
    });
  });

  it('주둔 요약은 수치를 받은 장수를 아군으로 보고 나머지를 타국·재야로 나눈다', () => {
    const sum = garrisonSummary([
      { ...army(1200, 95, 95), nationId: 1 },
      { ...army(0, 0, 0), nationId: 1 },
      { nationId: 2 },
      { nationId: 3 },
      { nationId: null },
    ]);
    expect(sum).toEqual({
      allies: 2,
      troops: 1200,
      withTroops: 1,
      ready90: { troops: 1200, count: 1 },
      ready60: { troops: 1200, count: 1 },
      foreign: 2,
      ronin: 1,
    });
  });
});

describe('국가 칸 군주·참모', () => {
  it('직책 12와 11의 이름을 고르고 빈 자리는 null이다', () => {
    expect(
      nationHeads([
        { name: '조조', officerLevel: 12 },
        { name: '순욱', officerLevel: 10 },
      ]),
    ).toEqual({ ruler: '조조', advisor: null });
  });

  it('직책이 오지 않는 다른 국가는 알 수 없다', () => {
    expect(nationHeads([{ name: '유비' }])).toBeUndefined();
  });
});

describe('중원 정세 글줄', () => {
  const names = {
    nation: (id: number) => ({ 1: '위', 2: '촉', 3: '오' })[id],
    city: (key: number) => ({ 10: '허창', 11: '완', 12: '성도', 13: '건업' })[key] ?? `도시 ${key}`,
  };
  const older = {
    nations: [
      { nationId: 1, cities: 2 },
      { nationId: 2, cities: 1 },
      { nationId: 9, cities: 1 },
    ],
    cities: [
      { cityKey: 10, nationId: 1 },
      { cityKey: 11, nationId: 1 },
      { cityKey: 12, nationId: 2 },
      { cityKey: 13, nationId: 9 },
    ],
  };

  it('건국·멸망과 도시 소유 변화를 새 주인별로 묶어 쓴다', () => {
    const current = {
      nations: [
        { nationId: 1, cities: 1 },
        { nationId: 2, cities: 2 },
        { nationId: 3, cities: 0 },
      ],
      cities: [
        { cityKey: 10, nationId: 1 },
        { cityKey: 11, nationId: 2 },
        { cityKey: 12, nationId: 2 },
        { cityKey: 13, nationId: null },
      ],
    };
    expect(worldEvents(current, older, names)).toEqual([
      '오가 일어났습니다.',
      '도시 1곳을 가졌던 세력이 사라졌습니다.',
      '촉이 완을 차지했습니다.',
      '건업이 공백지가 되었습니다.',
    ]);
  });

  it('앞 달이 없거나 변화가 없으면 글줄이 없다', () => {
    expect(worldEvents(older, undefined, names)).toEqual([]);
    expect(worldEvents(older, older, names)).toEqual([]);
  });
});
