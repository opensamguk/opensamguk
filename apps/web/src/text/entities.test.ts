import { describe, expect, it } from 'vitest';
import { buildMatcher, type TextEntity } from './entities';

// INT-29 글 속 이름 찾기: 장수·세력·도시 이름을 조각으로 나누고, 한 글자 이름과 단어 속 이름은 조심해서 잡는다.
const entities: TextEntity[] = [
  { kind: 'general', name: '조조', portraitId: 1, color: '#2f5ea8', id: 1 },
  { kind: 'general', name: '유비', portraitId: 2, color: '#2f7d45', id: 2 },
  { kind: 'nation', name: '위', color: '#2f5ea8', id: 1 },
  { kind: 'city', name: '하내', color: '#2f5ea8', id: 10 },
  { kind: 'city', name: '업', color: '#b8902a', id: 11 },
];
const m = buildMatcher(entities);
const kinds = (text: string) =>
  m
    .pieces(text)
    .map((p) => (p.type === 'entity' ? `${p.entity.kind}:${p.text}` : p.type === 'number' ? `n:${p.text}` : p.text));

describe('buildMatcher', () => {
  it('장수·도시 이름 뒤에 조사가 붙어도 이름만 잡는다', () => {
    expect(kinds('조조가 하내를 점령했다')).toEqual(['general:조조', '가 ', 'city:하내', '를 점령했다']);
  });

  it('단어 안의 이름은 잡지 않는다', () => {
    expect(kinds('자유비행')).toEqual(['자유비행']);
  });

  it('한 글자 이름은 뒤가 조사·경계일 때만 잡는다', () => {
    expect(kinds('위가 업을 얻었다')).toEqual(['nation:위', '가 ', 'city:업', '을 얻었다']);
    expect(kinds('위치를 바꿨다')).toEqual(['위치를 바꿨다']);
    expect(kinds('업무를 보았다')).toEqual(['업무를 보았다']);
    expect(kinds('위에 선전포고했다')).toEqual(['nation:위', '에 선전포고했다']);
  });

  it('부호 붙은 숫자와 숫자를 나눈다', () => {
    expect(kinds('농업 +1,200 (금 -300)')).toEqual(['농업 ', 'n:+1,200', ' (금 ', 'n:-300', ')']);
  });

  it('같은 이름이면 세력을 먼저 고른다', () => {
    const both = buildMatcher([
      { kind: 'general', name: '원소' },
      { kind: 'nation', name: '원소', color: '#b8902a' },
    ]);
    const piece = both.pieces('원소의 군세')[0]!;
    expect(piece.type === 'entity' && piece.entity.kind).toBe('nation');
  });
});
