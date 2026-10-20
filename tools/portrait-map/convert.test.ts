import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInitialWorld } from '../../packages/rules/src/index';
import { koreanName, matchPortraits, parseRegistry } from './convert';

const readings = JSON.parse(readFileSync(new URL('hanja-readings.json', import.meta.url), 'utf8')).readings as Record<
  string,
  string
>;
const registry = parseRegistry(readFileSync(new URL('registry.tsv', import.meta.url), 'utf8'));
const resource = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../resources/${path}`, import.meta.url), 'utf8'));
const input = {
  map: resource('map/che.json'),
  scenario: resource('scenario/1030.json'),
  unitSet: resource('unitset/basic.json'),
  statRules: resource('scenario/default.json'),
  seed: 'portraits',
};

describe('AC-M1-20 초상 이름 대응', () => {
  it('한자 독음과 이름 첫 음절의 두음법칙·성씨 예외를 적용한다', () => {
    for (const [kanji, name] of [
      ['曹操', '조조'],
      ['劉備', '유비'],
      ['李', '이'],
      ['呂布', '여포'],
      ['羅憲', '나헌'],
      ['諸葛亮', '제갈량'],
      ['樂進', '악진'],
    ])
      expect(koreanName(kanji!, readings)).toBe(name);
    expect(() => koreanName('🙂', readings)).toThrow('독음');
  });
  it('동명이인은 자동 선택하지 않고 후보·근거가 있는 수동 선택만 허용한다', () => {
    const result = matchPortraits(['조조', '고승', '한충', '없는이름'], registry, readings);
    expect(result.portraits).toEqual({ 조조: 10405 });
    expect(result.ambiguous.map((entry) => entry.name)).toEqual(['고승', '한충']);
    expect(result.unmatched).toEqual(['없는이름']);
    const candidates = result.ambiguous[0]!.candidates;
    expect(candidates.map((officer) => officer.kanji)).toEqual(['顧承', '高昇']);
    const manual = { 고승: { id: candidates[0]!.id, reason: '테스트에서 확인한 한자 顧承' } };
    expect(matchPortraits(['고승'], registry, readings, manual).portraits['고승']).toBe(10932);
    expect(() => matchPortraits(['고승'], registry, readings, { 고승: { id: 10405, reason: '조조' } })).toThrow('후보');
    expect(() => matchPortraits(['고승'], registry, readings, { 고승: { id: 10932, reason: '' } })).toThrow('근거');
    expect(
      matchPortraits(['조조1'], registry, readings, {
        조조1: { id: 10405, reason: '테스트용 번호 별칭, 曹操 확인' },
      }).portraits['조조1'],
    ).toBe(10405);
    expect(() =>
      matchPortraits(['없는이름'], registry, readings, {
        없는이름: { id: 99999, reason: 'registry에 없음' },
      }),
    ).toThrow('registry');
  });
  it('고정된 생성물이 재생성 결과와 같고 월드에 429/491명을 안전하게 붙인다', () => {
    const expected = resource('portraits/rtk14-map.json');
    const generated = matchPortraits(
      input.scenario.general.map((row: [number, string]) => row[1]),
      registry,
      readings,
    );
    expect({ ...expected, $comment: undefined }).toEqual({ ...generated, $comment: undefined });
    expect(generated.stats).toEqual({ matched: 429, total: 491, percent: 87.37 });
    const state = buildInitialWorld({ ...input, portraitMap: expected });
    expect(state.generals.filter((general) => general.portraitId !== null)).toHaveLength(429);
    expect(state.generals.find((general) => general.name === '유비')?.portraitId).toBe(10071);
    expect(state.generals.find((general) => general.name === '고승')?.portraitId).toBeNull();
    expect(state.generals.find((general) => general.name === '헌제')?.portraitId).toBeNull();
    expect(() => buildInitialWorld({ ...input, portraitMap: { portraits: { 조조: 1 } } })).toThrow();
  });
  it('중복·범위 밖 registry ID를 거부한다', () => {
    const header = 'id\tname_kanji\treading\n';
    expect(() => parseRegistry(header + '9999\t曹操\tソウソウ')).toThrow('행');
    expect(() => parseRegistry(header + '10001\t曹操\tソウソウ\n10001\t劉備\tリュウビ')).toThrow('행');
  });
});
