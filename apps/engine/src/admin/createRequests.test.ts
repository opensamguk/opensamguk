import type { PrismaClient } from '@opensamguk/db';
import { worldCreateIntent } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { afterEach, expect, it, vi } from 'vitest';
import * as resources from '../world/resources';
import { processWorldCreateRequest } from './createRequests';

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    name: '역사 프리셋',
    input: { presetKey: 'regular' },
    expected: {
      scenario: 'san10-191',
      map: 'san10',
      unitSet: 'basic',
      statRules: 'five-stats',
      portraitMap: '191-map',
    },
  },
  {
    name: '공백지 프리셋',
    input: { presetKey: 'empty' },
    expected: {
      scenario: 'san10-empty',
      map: 'san10',
      unitSet: 'basic',
      statRules: 'five-stats',
      portraitMap: '191-map',
    },
  },
  {
    name: 'SAN10 명시 자원',
    input: {
      scenarioKey: 'san10-191',
      mapKey: 'san10',
      statRulesKey: 'default',
      portraitMapKey: 'rtk14-map',
      turnTermMinutes: 30,
    },
    expected: { scenario: 'san10-191', map: 'san10', unitSet: 'basic', statRules: 'default', portraitMap: 'rtk14-map' },
  },
  {
    name: '구판 생략 자원',
    input: { scenarioKey: 'integration191', mapKey: 'integration', turnTermMinutes: 30 },
    expected: {
      scenario: 'integration191',
      map: 'integration',
      unitSet: 'basic',
      statRules: 'default',
      portraitMap: 'rtk14-map',
    },
  },
])('AC-M3-04 $name 생성은 공통 추론 결과로 자원을 읽고 접속 오류를 보존한다', async ({ input, expected }) => {
  const intent = worldCreateIntent({
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    name: '생성 추론 경계',
    seed: 'create-inference-only',
    endYear: 201,
    ...input,
  });
  const request = {
    id: '00000000-0000-4000-8000-000000000003',
    version: 1,
    intent,
    intentHash: hashState(intent),
    effectiveSeed: intent.seed,
  };
  const before = structuredClone(request),
    transportFailure = Object.assign(new Error('고정 접속 오류'), { code: 'P1001' }),
    read = vi.spyOn(resources, 'readInitialResources').mockRejectedValueOnce(transportFailure),
    transaction = vi.fn(),
    db = {
      worldCreateRequest: { findFirst: vi.fn(async () => request) },
      $transaction: transaction,
    } as unknown as PrismaClient;

  await expect(processWorldCreateRequest(db, new AbortController().signal)).rejects.toBe(transportFailure);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(db, expected);
  expect(transaction).not.toHaveBeenCalled();
  expect(request).toEqual(before);
});
