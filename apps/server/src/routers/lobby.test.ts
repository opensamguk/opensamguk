import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('T2-03 / AC-M2-02 로비 시나리오 이름', () => {
  beforeEach(async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockReset().mockImplementation(actual.readFile);
  });

  it('실제 시나리오의 title만 읽고 같은 키의 성공은 한 번만 읽는다', async () => {
    const { scenarioTitle } = await import('./lobby');
    expect(await scenarioTitle('1030')).toBe('【역사모드3】 군웅할거');
    expect(await scenarioTitle('1030')).toBe('【역사모드3】 군웅할거');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readFile).mock.calls[0]![0]).toEqual(
      new URL('../../../../resources/scenario/1030.json', import.meta.url),
    );
  });

  it.each(['../1030', 'default', ''])('키 %j는 파일을 열기 전에 거부한다', async (key) => {
    const { scenarioTitle } = await import('./lobby');
    await expect(scenarioTitle(key)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('없는 파일의 실패는 캐시하지 않고 경로와 키를 오류에 넣지 않는다', async () => {
    const { scenarioTitle } = await import('./lobby');
    for (let i = 0; i < 2; i++) {
      const error = await scenarioTitle('missing_t2_03').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'INTERNAL_SERVER_ERROR' });
      expect(String(error)).not.toContain('missing_t2_03');
      expect(error).toHaveProperty('cause', undefined);
    }
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    'not-json',
    JSON.stringify({ id: '1031', title: '군웅할거' }),
    JSON.stringify({ id: '1030', title: '' }),
    JSON.stringify({ id: '1030', title: null }),
    JSON.stringify({ id: '1030' }),
  ])('JSON·id·title이 잘못된 파일은 실패하고 캐시하지 않는다: %s', async (contents) => {
    vi.mocked(readFile).mockResolvedValueOnce(contents);
    const { scenarioTitle } = await import('./lobby');
    await expect(scenarioTitle('1030')).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(await scenarioTitle('1030')).toBe('【역사모드3】 군웅할거');
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
