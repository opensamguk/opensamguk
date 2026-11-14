import { expect, it } from 'vitest';
import { logPartsToText } from '@opensamguk/shared';
import { nationHistoryEvents, reputationRecord } from './recordParts';

it('평판은 저장된 이름·도시 스냅샷으로 본문과 조각을 함께 만든다', () => {
  const row = reputationRecord({
    generalId: 7,
    tick: 0,
    year: 190,
    month: 1,
    kind: 'conquest',
    score: 20,
    data: {
      name: '장수(사용자)',
      nation: { id: 1, name: '옛국가', color: '#123456' },
      city: { cityKey: 2, name: '옛도시' },
    },
  });
  expect(row.parts).toContainEqual({ t: 'general', id: 7, name: '장수(사용자)' });
  expect(row.parts).toContainEqual({ t: 'city', key: 2, name: '옛도시' });
  expect(row.text).toBe(logPartsToText(row.parts!));
});

it('옛 국가 문자열과 구조화 사건을 순번으로 연결하고 손상된 행만 대체한다', () => {
  const result = nationHistoryEvents({
    events: ['옛 사건', '누군가 살폈습니다', '미지원'],
    structuredEvents: [
      {
        ordinal: 1,
        kind: 'intel',
        visibility: 'nation',
        text: '누군가 살폈습니다',
        parts: [{ t: 'text', v: '누군가 살폈습니다' }],
        partsVersion: 1,
      },
      {
        ordinal: 2,
        kind: 'command',
        visibility: 'nation',
        text: '미지원',
        parts: [{ t: 'general', id: 9, name: '익명' }],
        partsVersion: 2,
      },
    ],
  });
  expect(result.map((row) => row.ordinal)).toEqual([0, 1, 2]);
  expect(result[0]).toMatchObject({ kind: 'legacy', parts: null, partsVersion: null });
  expect(result[1]!.parts).toEqual([{ t: 'text', v: '누군가 살폈습니다' }]);
  expect(JSON.stringify(result[1])).not.toContain('general');
  expect(result[2]).toMatchObject({ text: '미지원', parts: null, partsVersion: null });
  expect(nationHistoryEvents(null)).toEqual([]);
});
