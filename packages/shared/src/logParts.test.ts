import { expect, it } from 'vitest';
import {
  koreanParticle,
  logDisplayName,
  logPartsRecord,
  logPartsSchema,
  logPartsToText,
  readLogParts,
  type LogPart,
} from './logParts';

it('조각과 한 단계 tone을 평문으로 만들고 숫자의 자릿수와 부호를 보존한다', () => {
  const parts: LogPart[] = [
    { t: 'nation', id: 1, name: '한', color: '#123456' },
    { t: 'text', v: ' ' },
    { t: 'general', id: 2, name: '관우' },
    { t: 'city', key: 3, name: '허창' },
    { t: 'crew', id: 4, name: '창병' },
    { t: 'office', level: 0, name: '재야' },
    { t: 'act', key: 'farm', name: '개간' },
    {
      t: 'tone',
      v: 'good',
      parts: [
        { t: 'num', v: 1234, sign: true },
        { t: 'text', v: '/' },
        { t: 'num', v: -12.34, digits: 1, sign: true },
        { t: 'text', v: '/' },
        { t: 'num', v: 0, digits: 2, sign: true },
      ],
    },
  ];
  expect(logPartsSchema.parse(parts)).toEqual(parts);
  expect(logPartsToText(parts)).toBe('한 관우허창창병재야개간+1,234/-12.3/0.00');
  expect(logPartsRecord('옛 문장', parts).text).toBe(logPartsToText(parts));
});

it.each(['은/는', '이/가', '을/를', '과/와', '으로/로'] as const)('받침과 ㄹ 예외 및 중립 이름: %s', (pair) => {
  expect(koreanParticle('관우', pair)).toBe(pair.split('/')[1]);
  expect(koreanParticle('허창', pair)).toBe(pair.split('/')[0]);
  expect(koreanParticle('서울', pair)).toBe(pair === '으로/로' ? '로' : pair.split('/')[0]);
  expect(koreanParticle('NPC2', pair)).toBe('');
});

it('시스템 꼬리표만 제거하고 사용자 괄호는 보존한다', () => {
  expect(logDisplayName('조조(曹操)', true)).toBe('조조');
  expect(logDisplayName('유도(145년생)', true)).toBe('유도');
  expect(logDisplayName('장수(사용자)')).toBe('장수(사용자)');
  expect(logDisplayName('조조(曹操)')).toBe('조조(曹操)');
});

it('노드 수는 wrapper를 포함하고 JSON UTF-8 크기를 제한한다', () => {
  expect(logPartsSchema.safeParse(Array.from({ length: 64 }, () => ({ t: 'text', v: '' }))).success).toBe(true);
  expect(
    logPartsSchema.safeParse([
      { t: 'tone', v: 'good', parts: Array.from({ length: 63 }, () => ({ t: 'text', v: '' })) },
      { t: 'text', v: '' },
    ]).success,
  ).toBe(false);
  expect(
    logPartsSchema.safeParse([
      { t: 'text', v: '한'.repeat(400) },
      { t: 'text', v: '한'.repeat(400) },
    ]).success,
  ).toBe(false);
});

it.each(
  [
    [],
    [{ t: 'general', id: 0, name: '장수' }],
    [{ t: 'city', key: Number.MAX_SAFE_INTEGER + 1, name: '도시' }],
    [{ t: 'num', v: Infinity }],
    [{ t: 'num', v: 1, digits: 3 }],
    [{ t: 'text', v: '<b>이름</b>' }],
    [{ t: 'text', v: '첫째\n둘째' }],
    [{ t: 'text', v: 'a'.repeat(401) }],
    [{ t: 'nation', id: 1, name: '한', color: 'red' }],
    [{ t: 'act', key: 'a'.repeat(41), name: '행동' }],
    [{ t: 'tone', v: 'good', parts: [{ t: 'tone', v: 'bad', parts: [] }] }],
  ].map((parts) => ({ parts })),
)('손상된 조각은 평문으로 대체한다: %j', ({ parts }) => {
  expect(logPartsRecord('보존 문장', parts)).toEqual({ text: '보존 문장', parts: null, partsVersion: null });
});

it('옛 null 행과 모르는 버전은 조각을 사용하지 않는다', () => {
  expect(readLogParts(null, null)).toEqual({ parts: null, partsVersion: null });
  expect(readLogParts([{ t: 'text', v: '새 버전' }], 2)).toEqual({ parts: null, partsVersion: null });
});
