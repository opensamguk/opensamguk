import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  readInitialResources: vi.fn(),
  composeInitialWorld: vi.fn(),
  loadPreset: vi.fn(),
  createWorldFromCli: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('@opensamguk/db', () => ({ createDb: mocks.createDb }));
vi.mock('../world/resources', () => ({
  readInitialResources: mocks.readInitialResources,
  composeInitialWorld: mocks.composeInitialWorld,
  loadPreset: mocks.loadPreset,
}));
vi.mock('../admin/creation', () => ({ createWorldFromCli: mocks.createWorldFromCli }));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const publishedResources = { fixture: 'published unit resources' };
const args = [
  '--scenario',
  '1030',
  '--map',
  'che',
  '--seed',
  'cli-unit',
  '--turn-term',
  '30',
  '--end-year',
  '300',
  '--name',
  '생성 단위',
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'unit-only-not-a-connection');
  mocks.createDb.mockReturnValue({ $disconnect: mocks.disconnect });
  mocks.readInitialResources.mockResolvedValue(publishedResources);
  mocks.composeInitialWorld.mockReturnValue({ seed: 'cli-unit' });
  mocks.createWorldFromCli.mockResolvedValue({ worldId: 'created', stateHash: 'hash' });
  mocks.disconnect.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])('CLI는 --treaty 선택=%s를 실제 factory 인자로 전달한다 (의존 단위)', async (treaty) => {
  process.argv = [process.execPath, 'createWorld.ts', ...args, ...(treaty ? ['--treaty'] : [])];
  await import('./createWorld');
  await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
  expect(mocks.createDb).toHaveBeenCalledExactlyOnceWith('unit-only-not-a-connection');
  expect(mocks.createWorldFromCli).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    { seed: 'cli-unit' },
    {
      name: '생성 단위',
      turnTermMinutes: 30,
      endYear: 300,
      ...(treaty ? { treatyFormat: 1 } : {}),
    },
    publishedResources,
  );
  expect(mocks.readInitialResources).toHaveBeenCalledExactlyOnceWith(mocks.createDb.mock.results[0]!.value, {
    scenario: '1030',
    map: 'che',
    seed: 'cli-unit',
  });
  expect(mocks.composeInitialWorld).toHaveBeenCalledExactlyOnceWith(publishedResources, 'cli-unit');
  expect(console.error).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ worldId: 'created', stateHash: 'hash' }));
});

it('CLI boolean에 문자열 값을 넣으면 DB를 열기 전에 거부한다 (의존 단위)', async () => {
  process.argv = [process.execPath, 'createWorld.ts', ...args, '--treaty=1'];
  await import('./createWorld');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('treaty'));
  expect(mocks.createDb).not.toHaveBeenCalled();
  expect(mocks.createWorldFromCli).not.toHaveBeenCalled();
});

it.each([false, true])('확장 프리셋은 원작식 기능을 한 번만 합성한다 (명시=%s)', async (explicit) => {
  mocks.loadPreset.mockResolvedValue({
    scenario: 'san10-191',
    map: 'san10',
    unitSet: 'expanded',
    turnTermMinutes: 60,
  });
  mocks.composeInitialWorld.mockReturnValue({
    seed: 'cli-unit',
    unitSetKey: 'expanded',
    unitSet: { coefMode: 'multiply' },
    ruleFeatures: ['five-stats', 'operational-map'],
  });
  process.argv = [
    process.execPath,
    'createWorld.ts',
    '--preset',
    'regular',
    '--seed',
    'cli-unit',
    '--end-year',
    '231',
    '--name',
    '확장 생성',
    ...(explicit ? ['--rule-features', 'battle-affinity-v2'] : []),
  ];
  await import('./createWorld');
  await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
  expect(mocks.readInitialResources).toHaveBeenCalledWith(mocks.createDb.mock.results[0]!.value, {
    scenario: 'san10-191',
    map: 'san10',
    seed: 'cli-unit',
    unitSet: 'expanded',
  });
  const features = ['battle-affinity-v2', 'five-stats', 'operational-map'];
  expect(mocks.createWorldFromCli).toHaveBeenCalledWith(
    expect.anything(),
    { seed: 'cli-unit', unitSetKey: 'expanded', unitSet: { coefMode: 'multiply' }, ruleFeatures: features },
    expect.objectContaining({ ruleFeatures: features, preset: expect.objectContaining({ key: 'regular' }) }),
    publishedResources,
  );
  expect(console.error).not.toHaveBeenCalled();
});

it('자원 프로필과 요청 기능을 합칠 때 정렬한 뒤 의존 관계를 검사한다', async () => {
  mocks.composeInitialWorld.mockReturnValue({ seed: 'cli-unit', ruleFeatures: ['five-stats', 'operational-map'] });
  process.argv = [
    process.execPath,
    'createWorld.ts',
    ...args,
    '--rule-features',
    'treaty,campaign-v1,policy,personnel,stratagem-basic',
  ];
  await import('./createWorld');
  await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
  const features = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy', 'stratagem-basic', 'treaty'];
  expect(mocks.createWorldFromCli).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    { seed: 'cli-unit', ruleFeatures: features },
    expect.objectContaining({ ruleFeatures: features }),
    publishedResources,
  );
  expect(console.error).not.toHaveBeenCalled();
});

it.each(['campaign-v1,personnel', 'policy,policy', 'unknown-feature'])(
  '잘못된 기능 %s는 생성하지 않고 연결을 닫는다',
  async (features) => {
    process.argv = [process.execPath, 'createWorld.ts', ...args, '--rule-features', features];
    await import('./createWorld');
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(mocks.createWorldFromCli).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  },
);

it('실제 CLI 자식 프로세스의 도움말은 --treaty를 안내한다 (DB 생성 증거 아님)', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./createWorld.ts', import.meta.url)), '--help'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  expect(output).toContain('[--treaty]');
  expect(output).toContain('pnpm world:create');
});

it('AC-P2-27 실제 CLI의 2판 선택도 DB 설정이 없으면 생성하지 않는다', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./createWorld.ts', import.meta.url)), ...args, '--unit-set', 'basic@2'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('DATABASE_URL이 없습니다.');
  expect(result.stderr).not.toMatch(/게시된 판으로 생성하세요|ENOENT|basic\.json/);
  expect(result.stdout).toBe('');
});
