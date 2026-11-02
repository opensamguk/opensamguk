import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { composeBudget } from './admission';
import { LOAD_DOCKER } from './docker';
import {
  assertContainerLimits,
  assertContainerOwnership,
  partitionOwnedContainers,
  renderLoadCompose,
  requireImageSource,
  verifyDatabaseIdentity,
} from './run';

describe('L4 실제 실행 전 소유권/source/compose 계약', () => {
  const host = {
    CgroupParent: LOAD_DOCKER.cgroupParent,
    NanoCpus: 0.5e9,
    Memory: 1024 ** 3,
    MemorySwap: 1024 ** 3,
    Privileged: false,
    ReadonlyRootfs: true,
    PortBindings: null,
  };
  it('저장소의 동일 compose에서 formal과 smoke 제한 합을 각각 읽는다', async () => {
    const source = await readFile(new URL('../../deploy/load/compose.yml', import.meta.url), 'utf8');
    expect(composeBudget(renderLoadCompose(source, 'formal'), 'formal')).toEqual({
      cpu: 3,
      memoryBytes: 5 * 1024 ** 3,
      diskBytes: 5 * 1024 ** 3,
    });
    expect(composeBudget(renderLoadCompose(source, 'smoke'), 'smoke')).toEqual({
      cpu: 1.25,
      memoryBytes: 2.5 * 1024 ** 3,
      diskBytes: 3 * 1024 ** 3,
    });
    for (const mode of ['formal', 'smoke'] as const) {
      const parsed: unknown = parse(renderLoadCompose(source, mode));
      expect(parsed).toMatchObject({
        services: {
          postgres: { cgroup_parent: LOAD_DOCKER.cgroupParent },
          server: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
          engine: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
          generator: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
        },
      });
    }
    expect(() =>
      renderLoadCompose(
        source.replace(
          "['/tmp:rw,noexec,nosuid,size=64m,mode=1777']",
          '[/tmp:rw, noexec, nosuid, size=64m, mode=1777]',
        ),
        'formal',
      ),
    ).toThrow('LOAD_COMPOSE_TMPFS_INVALID');
    expect(() =>
      renderLoadCompose(source.replaceAll('cgroup_parent: system.slice', 'cgroup_parent: narrow.slice'), 'formal'),
    ).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
  });
  it('이미지 tag나 label 한쪽만 일치하는 source를 허용하지 않는다', () => {
    const labels = {
      'org.opencontainers.image.revision': 'a'.repeat(40),
      'org.opensamguk.source-tree-sha256': 'b'.repeat(64),
    };
    const image = { Id: `sha256:${'c'.repeat(64)}`, Config: { Labels: labels } };
    expect(requireImageSource([image], 'a'.repeat(40), 'b'.repeat(64))).toBe(image.Id);
    expect(() => requireImageSource([image], 'd'.repeat(40), 'b'.repeat(64))).toThrow();
    expect(() => requireImageSource([{ ...image, Id: 'latest' }], 'a'.repeat(40), 'b'.repeat(64))).toThrow();
  });
  it('네 서비스가 모두 새 UUID 프로젝트와 run label에 결속돼야 한다', () => {
    const rows = ['postgres', 'server', 'engine', 'generator'].map((name, index) => ({
      Id: String(index).repeat(64),
      Name: name,
      Config: {
        Labels: {
          'com.docker.compose.project': 'owned',
          'org.opensamguk.load.run': 'run',
          'com.docker.compose.service': name,
        },
      },
      State: { Running: true, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
      HostConfig: host,
    }));
    expect(() => assertContainerOwnership(rows, 'owned', 'run')).not.toThrow();
    expect(() => assertContainerOwnership(rows.slice(0, 3), 'owned', 'run')).toThrow();
    expect(() => assertContainerOwnership(rows, 'peer', 'run')).toThrow();
    expect(() => assertContainerOwnership([...rows.slice(0, 3), rows[0]!], 'owned', 'run')).toThrow();
  });
  it('실제 Docker quota/image/loopback 바인딩을 source compose와 별도로 검사한다', () => {
    const row = {
      Id: 'a'.repeat(64),
      Name: '/owned-server-1',
      Config: { Labels: { 'com.docker.compose.service': 'server' } },
      State: { Running: false, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
      Image: 'app-image',
      HostConfig: {
        CgroupParent: LOAD_DOCKER.cgroupParent,
        NanoCpus: 0.5e9,
        Memory: 1024 ** 3,
        MemorySwap: 1024 ** 3,
        Privileged: false,
        ReadonlyRootfs: true,
        PortBindings: { '3001/tcp': [{ HostIp: '127.0.0.1' }] },
      },
    };
    expect(() => assertContainerLimits([row], 'formal', 'app-image', 'pg-image')).not.toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, NanoCpus: 0 } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, PortBindings: { '3001/tcp': [{ HostIp: '0.0.0.0' }] } } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow();
    expect(() => assertContainerLimits([{ ...row, Image: 'peer' }], 'formal', 'app-image', 'pg-image')).toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, CgroupParent: 'narrow.slice' } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
  });
  it('중도 실패의 임시 컨테이너도 정확 이름과 run/project label이 있어야 정리 후보가 된다', () => {
    const row = {
      Id: 'a'.repeat(64),
      Name: '/owned-migrations',
      Config: {
        Labels: {
          'com.docker.compose.project': 'owned',
          'org.opensamguk.load.run': 'run',
          'com.docker.compose.oneoff': 'True',
        },
      },
      State: { Running: true, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
    };
    expect(partitionOwnedContainers([row], 'owned', 'run').auxiliary).toEqual([row]);
    expect(() => partitionOwnedContainers([{ ...row, Name: '/owned-peer' }], 'owned', 'run')).toThrow();
    expect(() => partitionOwnedContainers([row], 'owned', 'peer-run')).toThrow();
  });
  it('DB 이름/OID가 재생성됐거나 연결 수를 모르면 삭제 근거로 인정하지 않는다', () => {
    const text = JSON.stringify({ name: 'owned_test', oid: 101, connections: 0 });
    expect(verifyDatabaseIdentity(text, { name: 'owned_test', oid: 101 })).toEqual({
      name: 'owned_test',
      oid: 101,
      connections: 0,
    });
    expect(() => verifyDatabaseIdentity(text, { name: 'owned_test', oid: 102 })).toThrow();
    expect(() => verifyDatabaseIdentity(text, { name: 'peer_test' })).toThrow();
    expect(() => verifyDatabaseIdentity('{"name":"owned_test","oid":101}', { name: 'owned_test' })).toThrow();
    expect(() => verifyDatabaseIdentity('private-canary', { name: 'owned_test' })).toThrow(
      /^LOAD_DATABASE_IDENTITY_INVALID$/,
    );
  });
});
