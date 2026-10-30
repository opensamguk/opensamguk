import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cityResourceInputSchema } from '@opensamguk/rules';
import { z } from 'zod';
import type { Context } from '../context';
import { nationCommandsRouter } from '../routers/nationCommands';
import { parseOfficeTurn } from './nationOfficeSlots';
import { requireWorld, requireGeneral } from './queries';

vi.mock('./queries', async (original) => ({
  ...(await original<typeof import('./queries')>()),
  requireWorld: vi.fn(),
  requireGeneral: vi.fn(),
}));
vi.mock('./personnelApi', () => ({
  withPersonnel: async (_ctx: unknown, _id: string, read: (tx: unknown) => unknown) => read({}),
}));
vi.mock('./resolver', () => ({
  worldResolver: () => ({
    resolver: {
      list: () => [
        { key: 'nation_rest', name: '휴식', target: 'nation', args: z.strictObject({}) },
        { key: 'nation_city_allocate', name: '도시 병력 배속', target: 'nation', args: cityResourceInputSchema },
      ],
      get: (key: string) =>
        key === 'nation_city_allocate'
          ? { key, name: '도시 병력 배속', target: 'nation', args: cityResourceInputSchema }
          : { key, name: '휴식', target: 'nation', args: z.strictObject({}) },
    },
  }),
}));

beforeEach(() => vi.resetAllMocks());
const args = { cityKey: 1, unitId: 2, crewType: 1100, amount: 50 };
function fixture(enabled = true, level = 5) {
  const world = {
    id: '10000000-0000-4000-8000-000000000001',
    ruleFeatures: enabled ? ['city-resources-v1'] : [],
  } as unknown as Awaited<ReturnType<typeof requireWorld>>;
  vi.mocked(requireWorld).mockResolvedValue(world);
  vi.mocked(requireGeneral).mockResolvedValue({ id: 1, nationId: 1, officerLevel: level } as Awaited<
    ReturnType<typeof requireGeneral>
  >);
  const caller = nationCommandsRouter.createCaller({ user: { id: '10000000-0000-4000-8000-000000000002' } } as Context);
  return { world, caller };
}
describe('AC-INT-18B 도시 배속 국가 예약의 서버 권한', () => {
  it.each([5, 6, 7, 8, 9, 10, 11, 12])('새 판 직책 %i는 목록과 엄격한 인자 파싱을 함께 허용한다', async (level) => {
    const f = fixture(true, level);
    expect(parseOfficeTurn(f.world, level, { commandKey: 'nation_city_allocate', args })).toEqual({
      commandKey: 'nation_city_allocate',
      args,
    });
    expect(await f.caller.list({ worldId: f.world.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'nation_city_allocate' })]),
    );
  });
  it('구판은 새 명령을 숨기고 저장을 거부하며 휴식은 그대로다', async () => {
    const f = fixture(false);
    expect(() => parseOfficeTurn(f.world, 5, { commandKey: 'nation_city_allocate', args })).toThrow('명령과 인자');
    expect(parseOfficeTurn(f.world, 5, { commandKey: 'nation_rest', args: {} })).toEqual({
      commandKey: 'nation_rest',
      args: {},
    });
    expect(await f.caller.list({ worldId: f.world.id })).toEqual([expect.objectContaining({ key: 'nation_rest' })]);
  });
  it.each([0, 4, 13])('직책 %i는 추가 권한을 얻지 않는다', async (level) => {
    const f = fixture(true, level);
    expect(() => parseOfficeTurn(f.world, level, { commandKey: 'nation_city_allocate', args })).toThrow('명령과 인자');
    await expect(f.caller.list({ worldId: f.world.id })).rejects.toHaveProperty('code', 'FORBIDDEN');
  });
  it('잘못된 수량과 전역 revision을 새 예약 인자로 받지 않는다', () => {
    const f = fixture();
    for (const invalid of [
      { ...args, amount: 0 },
      { ...args, revision: 0 },
    ])
      expect(() => parseOfficeTurn(f.world, 5, { commandKey: 'nation_city_allocate', args: invalid })).toThrow(
        '명령과 인자',
      );
  });
});
