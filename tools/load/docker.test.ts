import { describe, expect, it } from 'vitest';
import { assertDockerParent, assertRunningDockerParent, bindLocalDocker, LOAD_DOCKER } from './docker';

describe('L4 로컬 Docker endpoint와 명시 systemd parent', () => {
  it.each(['ssh://user:private-canary@remote', 'tcp://remote:2376', 'unix:///other/docker.sock'])(
    '환경변수가 없어도 선택된 remote/다른 context는 자원 변경 전에 거부한다',
    async (endpoint) => {
      const calls: string[][] = [];
      const mutableCalls: string[][] = [];
      await expect(
        bindLocalDocker(
          async (args) => {
            calls.push([...args]);
            if (args[0] !== 'context') mutableCalls.push([...args]);
            return args[1] === 'show' ? 'persisted-context\n' : JSON.stringify(endpoint);
          },
          new AbortController().signal,
          {},
          async () => LOAD_DOCKER.cgroupPath,
        ),
      ).rejects.toThrow(/^LOAD_LOCAL_DOCKER_REQUIRED$/);
      expect(calls).toHaveLength(2);
      expect(mutableCalls).toEqual([]);
    },
  );
  it('검증 뒤 context/env가 바뀌어도 모든 실제 명령을 같은 --host에 결속한다', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const { run, binding } = await bindLocalDocker(
      async (args, _label, _signal, _timeout, env) => {
        calls.push({ args, env });
        return args[1] === 'show' ? 'default' : JSON.stringify(LOAD_DOCKER.endpoint);
      },
      new AbortController().signal,
      {},
      async () => LOAD_DOCKER.cgroupPath,
    );
    expect(binding).toEqual(LOAD_DOCKER);
    for (const command of ['info', 'compose', 'run', 'buildx', 'volume', 'stop', 'rm'])
      await run([command], 'test', new AbortController().signal, 10, {
        DOCKER_HOST: 'private-canary',
        DOCKER_CONTEXT: 'private-canary',
      });
    for (const call of calls.slice(2)) {
      expect(call.args.slice(0, 2)).toEqual(['--host', LOAD_DOCKER.endpoint]);
      expect(call.env?.DOCKER_HOST).toBeUndefined();
      expect(call.env?.DOCKER_CONTEXT).toBeUndefined();
    }
  });
  it.each(['missing', '/sys/fs/cgroup/other.slice'])(
    'parent가 없거나 실제 경로가 다르면 선택 endpoint가 로컬이어도 거부한다',
    async (path) => {
      await expect(
        bindLocalDocker(
          async (args) => (args[1] === 'show' ? 'default' : JSON.stringify(LOAD_DOCKER.endpoint)),
          new AbortController().signal,
          {},
          async () => {
            if (path === 'missing') throw new Error('private-canary');
            return path;
          },
        ),
      ).rejects.toThrow(/^LOAD_LOCAL_DOCKER_REQUIRED$/);
    },
  );
  it('알 수 없거나 더 좁은 daemon parent를 실제 HostConfig/커널 경로 대신 인정하지 않는다', () => {
    const row = {
      Id: 'a'.repeat(64),
      State: { Running: true, Pid: 123 },
      HostConfig: { CgroupParent: 'system.slice' },
    };
    const path = `0::/system.slice/docker-${row.Id}.scope\n`;
    expect(() => assertRunningDockerParent(row, path, LOAD_DOCKER)).not.toThrow();
    expect(() => assertDockerParent(undefined, LOAD_DOCKER)).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
    expect(() => assertDockerParent('narrow.slice', LOAD_DOCKER)).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
    expect(() => assertRunningDockerParent(row, `0::/narrow.slice/docker-${row.Id}.scope\n`, LOAD_DOCKER)).toThrow();
    expect(() => assertRunningDockerParent(row, path.replace(row.Id, 'b'.repeat(64)), LOAD_DOCKER)).toThrow();
    expect(() => assertRunningDockerParent({ ...row, State: { Running: false, Pid: 0 } }, path, LOAD_DOCKER)).toThrow();
  });
});
