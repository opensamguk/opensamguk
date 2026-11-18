import { describe, expect, it } from 'vitest';
import { pickModel, regionTint, tileFill, zoomTier } from './siteModels';

// INT-27 D-094: 거점 종류·단계별 모형 고르기와 거리 단계.
describe('pickModel', () => {
  const four = new Set(['capital', 'pass', 'camp', 'houses']);

  it('특은 수도 모형, 경·대는 전용 모형이 없으면 수도 모형으로 대신한다', () => {
    expect(pickModel('CITY', 8, four)).toBe('capital');
    expect(pickModel('CITY', 9, four)).toBe('capital');
    expect(pickModel('CITY', 9, new Set([...four, 'city-9']))).toBe('city-9');
    expect(pickModel('CITY', 7, four)).toBe('capital');
  });

  it('진(현성)은 민가, 이는 진영, 소·중은 민가, 관문은 관문 모형이다', () => {
    // D-096: 진은 큰 도시에 딸린 현성이라 마을 그림이다.
    expect(pickModel('CITY', 2, four)).toBe('houses');
    expect(pickModel('CITY', 4, four)).toBe('camp');
    expect(pickModel('CITY', 5, four)).toBe('houses');
    expect(pickModel('CITY', 6, new Set([...four, 'city-5']))).toBe('city-5');
    expect(pickModel('PASS', undefined, four)).toBe('pass');
  });

  it('이민족·동이는 종족·지역 그림, 중국 성은 지역 무리 그림을 먼저 고른다', () => {
    const drawn = new Set([...four, 'city-7', 'tribe-xianbei', 'east-okjeo-ye', 'yang-city-7']);
    expect(pickModel('CITY', 4, drawn, { name: '선비', region: 16 })).toBe('tribe-xianbei');
    expect(pickModel('CITY', 4, drawn, { name: '흉노', region: 16 })).toBe('camp');
    expect(pickModel('CITY', 5, drawn, { name: '읍루', region: 15 })).toBe('east-okjeo-ye');
    expect(pickModel('CITY', 7, drawn, { name: '오', region: 8 })).toBe('yang-city-7');
    expect(pickModel('CITY', 7, drawn, { name: '완', region: 7 })).toBe('city-7');
    expect(pickModel('CITY', 7, drawn, { name: '낙양', region: 1 })).toBe('city-7');
    // 동이 나라는 크기별 판을 먼저(없으면 작은 판, 마지막에 소 판).
    const wa = new Set(['east-wa', 'east-wa-6', 'houses']);
    expect(pickModel('CITY', 7, wa, { name: '야마타이국', region: 15 })).toBe('east-wa-6');
    expect(pickModel('CITY', 5, wa, { name: '노국', region: 15 })).toBe('east-wa');
    // 현 마을도 지역 그림을 먼저, 없으면 공통 마을 그림.
    expect(pickModel('CITY', 2, new Set(['houses', 'yang-houses']), { name: '송양', region: 8 })).toBe('yang-houses');
    expect(pickModel('CITY', 2, new Set(['houses', 'yang-houses']), { name: '의양', region: 2 })).toBe('houses');
    expect(pickModel('FIELD', undefined, new Set(['battlefield', 'camp']))).toBe('battlefield');
    expect(pickModel('CITY', 1, new Set(['water-fort', 'camp']))).toBe('water-fort');
  });

  it('후보가 하나도 없으면 null', () => {
    expect(pickModel('CITY', 8, new Set())).toBeNull();
  });
});

describe('tileFill', () => {
  it('모형은 칸 한 칸 안에 들고 큰 도시일수록 칸을 더 채운다', () => {
    const levels = [2, 5, 6, 7, 8, 9].map((level) => tileFill('CITY', level));
    expect(levels.every((fill) => fill > 0 && fill <= 1)).toBe(true);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(tileFill('CITY', 9)).toBeGreaterThan(tileFill('CITY', 8));
  });
});

describe('regionTint', () => {
  it('지역마다 다른 색, 모르는 지역은 흰색', () => {
    expect(regionTint(9)).not.toBe(regionTint(8));
    expect(regionTint(undefined)).toBe('#ffffff');
    expect(regionTint(99)).toBe('#ffffff');
  });
});

describe('zoomTier', () => {
  it('보이는 지도 폭으로 네 단계를 나누고 가까울수록 자세한 모형', () => {
    expect(zoomTier(1400)).toBe(1);
    expect(zoomTier(400)).toBe(2);
    expect(zoomTier(150)).toBe(3);
    expect(zoomTier(40)).toBe(4);
  });
});
