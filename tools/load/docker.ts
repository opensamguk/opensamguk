import { realpath } from 'node:fs/promises';
import { selfCgroupPath } from './observe';

// 기본 context/daemon 설정을 추정하지 않는다. 이 실행에서 허용하는 로컬 endpoint와
// systemd parent를 명시하고, 모든 Docker 호출과 실제 컨테이너 관측에 같은 값을 쓴다.
export const LOAD_DOCKER = Object.freeze({
  endpoint: 'unix:///var/run/docker.sock',
  cgroupParent: 'system.slice',
  cgroupPath: '/sys/fs/cgroup/system.slice',
});
export type DockerBinding = typeof LOAD_DOCKER;
export type DockerCommand = (
  args: readonly string[],
  label: string,
  signal: AbortSignal,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export async function bindLocalDocker(
  raw: DockerCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
  resolveParent: (path: string) => Promise<string> = realpath,
): Promise<{ binding: DockerBinding; run: DockerCommand }> {
  if (environment.DOCKER_HOST !== undefined || environment.DOCKER_CONTEXT !== undefined)
    throw new Error('LOAD_LOCAL_DOCKER_REQUIRED');
  try {
    signal.throwIfAborted();
    const context = (await raw(['context', 'show'], 'docker-context-selection', signal, 10_000, environment)).trim();
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(context)) throw new Error();
    const endpoint: unknown = JSON.parse(
      await raw(
        ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
        'docker-context-endpoint',
        signal,
        10_000,
        environment,
      ),
    );
    signal.throwIfAborted();
    if (endpoint !== LOAD_DOCKER.endpoint) throw new Error();
    // 심사할 parent가 실제 로컬 cgroup 경로여야 한다. 없거나 다른 곳을 가리키면 거부한다.
    if ((await resolveParent(LOAD_DOCKER.cgroupPath)) !== LOAD_DOCKER.cgroupPath) throw new Error();
    signal.throwIfAborted();
  } catch {
    // context 이름/endpoint/JSON 원문/파일 오류에는 주소나 인증값이 있을 수 있다.
    throw new Error('LOAD_LOCAL_DOCKER_REQUIRED');
  }
  return {
    binding: LOAD_DOCKER,
    run: (args, label, ownSignal, timeoutMs, env) => {
      const cleanEnvironment = { ...(env ?? environment) };
      delete cleanEnvironment.DOCKER_HOST;
      delete cleanEnvironment.DOCKER_CONTEXT;
      return raw(['--host', LOAD_DOCKER.endpoint, ...args], label, ownSignal, timeoutMs, cleanEnvironment);
    },
  };
}

export function assertDockerParent(actual: unknown, binding: DockerBinding): void {
  if (actual !== binding.cgroupParent) throw new Error('LOAD_CONTAINER_CGROUP_UNVERIFIED');
}

export function assertRunningDockerParent(
  row: { Id: string; State: { Running: boolean; Pid?: number }; HostConfig?: { CgroupParent?: string } },
  cgroupText: string,
  binding: DockerBinding,
): void {
  assertDockerParent(row.HostConfig?.CgroupParent, binding);
  if (
    !/^[a-f0-9]{64}$/.test(row.Id) ||
    !row.State.Running ||
    !Number.isSafeInteger(row.State.Pid) ||
    (row.State.Pid ?? 0) <= 0 ||
    selfCgroupPath(cgroupText) !== `${binding.cgroupPath}/docker-${row.Id}.scope`
  )
    throw new Error('LOAD_CONTAINER_CGROUP_UNVERIFIED');
}
