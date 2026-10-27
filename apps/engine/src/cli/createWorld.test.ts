import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  loadInitialWorld: vi.fn(),
  loadPreset: vi.fn(),
  saveInitialWorld: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('@opensamguk/db', () => ({ createDb: mocks.createDb }));
vi.mock('../world/resources', () => ({ loadInitialWorld: mocks.loadInitialWorld, loadPreset: mocks.loadPreset }));
vi.mock('../world/persistence', () => ({ saveInitialWorld: mocks.saveInitialWorld }));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
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
  mocks.loadInitialWorld.mockResolvedValue({ seed: 'cli-unit' });
  mocks.saveInitialWorld.mockResolvedValue({ worldId: 'created', stateHash: 'hash' });
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
  expect(mocks.saveInitialWorld).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    { seed: 'cli-unit' },
    {
      name: '생성 단위',
      turnTermMinutes: 30,
      endYear: 300,
      ...(treaty ? { treatyFormat: 1 } : {}),
    },
  );
  expect(console.error).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ worldId: 'created', stateHash: 'hash' }));
});

it('CLI boolean에 문자열 값을 넣으면 DB를 열기 전에 거부한다 (의존 단위)', async () => {
  process.argv = [process.execPath, 'createWorld.ts', ...args, '--treaty=1'];
  await import('./createWorld');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('treaty'));
  expect(mocks.createDb).not.toHaveBeenCalled();
  expect(mocks.saveInitialWorld).not.toHaveBeenCalled();
});

it('자원 프로필과 요청 기능을 합칠 때 정렬한 뒤 의존 관계를 검사한다', async () => {
  mocks.loadInitialWorld.mockResolvedValue({ seed: 'cli-unit', ruleFeatures: ['five-stats', 'operational-map'] });
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
  expect(mocks.saveInitialWorld).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    { seed: 'cli-unit', ruleFeatures: features },
    expect.objectContaining({ ruleFeatures: features }),
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
    expect(mocks.saveInitialWorld).not.toHaveBeenCalled();
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
