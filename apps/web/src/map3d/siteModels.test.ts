import { describe, expect, it } from 'vitest';
import { lodForPixels, pickModel, tileFill } from './siteModels';

// INT-27 D-094: 거점 종류·단계별 모형 고르기와 거리 단계.
describe('pickModel', () => {
  const four = new Set(['capital', 'pass', 'camp', 'houses']);

  it('특은 수도 모형, 경·대는 전용 모형이 없으면 수도 모형으로 대신한다', () => {
    expect(pickModel('CITY', 8, four)).toBe('capital');
    expect(pickModel('CITY', 9, four)).toBe('capital');
    expect(pickModel('CITY', 9, new Set([...four, 'city-9']))).toBe('city-9');
    expect(pickModel('CITY', 7, four)).toBe('capital');
  });

  it('진·이는 진영, 소·중은 민가, 관문은 관문 모형이다', () => {
    expect(pickModel('CITY', 2, four)).toBe('camp');
    expect(pickModel('CITY', 4, four)).toBe('camp');
    expect(pickModel('CITY', 5, four)).toBe('houses');
    expect(pickModel('CITY', 6, new Set([...four, 'city-5']))).toBe('city-5');
    expect(pickModel('PASS', undefined, four)).toBe('pass');
  });

  it('후보가 하나도 없으면 null', () => {
    expect(pickModel('CITY', 8, new Set())).toBeNull();
  });
});

describe('lodForPixels', () => {
  it('화면에서 클수록 자세한 단계', () => {
    expect(lodForPixels(300)).toBe(0);
    expect(lodForPixels(80)).toBe(1);
    expect(lodForPixels(20)).toBe(2);
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
