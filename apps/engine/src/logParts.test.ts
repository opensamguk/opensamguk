import { expect, it } from 'vitest';
import { commandLogLines, nationCommandLogLines, storedLog } from './logParts';
import { logPartsToText } from '@opensamguk/shared';

it('명령 불가 코드는 본문과 분리하고 지원 버전으로 저장한다', () => {
  expect(commandLogLines({ code: 'NO_GOLD', message: '금이 부족합니다.' })).toEqual([
    {
      kind: 'failure',
      code: 'NO_GOLD',
      text: '금이 부족합니다.',
      parts: [{ t: 'text', v: '금이 부족합니다.' }],
      partsVersion: 1,
    },
  ]);
});

it.each(['PROTECTED', 'VASSAL_BOUND'] as const)(
  '국가 명령 실패 %s는 기존 사건 본문과 조각에 코드를 보존한다',
  (code) => {
    const message = '선전포고할 수 없습니다.';
    const [row] = nationCommandLogLines('nation_declare', '선전포고', { code, message });
    expect(row).toEqual({
      text: `선전포고: ${code}: ${message}`,
      parts: [
        { t: 'act', key: 'nation_declare', name: '선전포고' },
        { t: 'text', v: `: ${code}: ` },
        { t: 'text', v: message },
      ],
      partsVersion: 1,
    });
  },
);

it('국가 명령 성공은 코드를 붙이지 않고 기존 조각을 보존한다', () => {
  expect(
    nationCommandLogLines('nation_rest', '대기', {
      effects: [],
      logs: [{ kind: 'success', text: '대기', parts: [{ t: 'act', key: 'nation_rest', name: '대기' }] }],
    }),
  ).toEqual([
    {
      text: '대기: 대기',
      parts: [
        { t: 'act', key: 'nation_rest', name: '대기' },
        { t: 'text', v: ': ' },
        { t: 'act', key: 'nation_rest', name: '대기' },
      ],
      partsVersion: 1,
    },
  ]);
});

it('논리적 줄과 kind를 보존하고 옛 다중 줄은 조각 없이 나눈다', () => {
  const lines = commandLogLines({
    effects: [],
    logs: [
      { kind: 'success', text: '옛 첫째\n옛 둘째' },
      { kind: 'failure', text: '실패', parts: [{ t: 'tone', v: 'bad', parts: [{ t: 'text', v: '시도 실패' }] }] },
    ],
  });
  expect(lines).toHaveLength(3);
  expect(lines.slice(0, 2)).toEqual([
    { kind: 'success', text: '옛 첫째' },
    { kind: 'success', text: '옛 둘째' },
  ]);
  const row = lines[2]!;
  expect(row.kind).toBe('failure');
  if (!('parts' in row)) throw Error('지원 조각이 없습니다.');
  expect(row.partsVersion).toBe(1);
  expect(row.text).toBe(logPartsToText(row.parts as Parameters<typeof logPartsToText>[0]));
});

it('크기 초과·손상 조각은 text만 저장한다', () => {
  const text = '보존 문장';
  expect(storedLog(text, [{ t: 'general', id: 0, name: '장수' }])).toEqual({ text });
  expect(
    storedLog(
      text,
      Array.from({ length: 65 }, () => ({ t: 'text', v: '' })),
    ),
  ).toEqual({ text });
  expect(
    storedLog(text, [
      { t: 'text', v: '한'.repeat(400) },
      { t: 'text', v: '한'.repeat(400) },
    ]),
  ).toEqual({ text });
});
