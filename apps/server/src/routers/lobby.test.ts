import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import { scenarioTitle } from './lobby';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const title = '【역사모드3】 군웅할거';
const valid = { id: '1030', title };
const findMany = vi.fn(async () => [] as Record<string, unknown>[]);
const db = { gameResource: { findMany } } as unknown as Parameters<typeof scenarioTitle>[1];
const row = (content: unknown, version = 1) => ({
  kind: 'SCENARIO',
  name: '1030',
  version,
  content,
  contentHash: hashState(content),
  source: 'unit fixture',
});

describe('T2-03·T4-77 / AC-M2-02·AC-P2-26 로비 시나리오 이름', () => {
  beforeEach(() => {
    findMany.mockReset();
    vi.mocked(readFile).mockClear();
  });

  it('게시된 정확한 판의 title을 읽고 DB 결과는 캐시하지 않는다', async () => {
    findMany.mockResolvedValue([row(valid)]);
    expect(await scenarioTitle('1030', db)).toBe(title);
    expect(await scenarioTitle('1030', db)).toBe(title);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { status: 'PUBLISHED', OR: [{ kind: 'SCENARIO', name: '1030', version: 1 }] } }),
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['../1030', ''])('잘못된 키 %j는 DB·파일 접근 전에 거부한다', async (key) => {
    await expect(scenarioTitle(key, db)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(findMany).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['default', 'missing_t2_03'])('미게시 키 %s는 캐시·파일 대체 없이 오류를 가린다', async (key) => {
    findMany.mockResolvedValue([]);
    for (let i = 0; i < 2; i++) {
      const error = await scenarioTitle(key, db).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'INTERNAL_SERVER_ERROR' });
      expect(String(error)).not.toContain(key);
      expect(error).toHaveProperty('cause', undefined);
    }
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    'not-json',
    { id: '1031', title: '군웅할거' },
    { id: '1030', title: '' },
    { id: '1030', title: null },
    { id: '1030' },
  ])('잘못된 게시 내용은 실패하고 음성 캐시를 남기지 않는다: %j', async (content) => {
    findMany.mockResolvedValueOnce([row(content)]).mockResolvedValueOnce([row(valid)]);
    await expect(scenarioTitle('1030', db)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(await scenarioTitle('1030', db)).toBe(title);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('2판은 1판 제목으로 대체하지 않는다', async () => {
    findMany.mockResolvedValue([row({ ...valid, title: '둘째 판' }, 2)]);
    expect(await scenarioTitle('1030@2', db)).toBe('둘째 판');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PUBLISHED', OR: [{ kind: 'SCENARIO', name: '1030', version: 2 }] } }),
    );
  });
});
