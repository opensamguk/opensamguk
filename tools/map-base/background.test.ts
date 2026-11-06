import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { readMapBackgroundImage } from './background';

it('AC-P2-28 등록 메타데이터는 작업 파일 대신 정확한 이미지 커밋에서 읽는다', () => {
  const repository = mkdtempSync(join(tmpdir(), 't4-89-image-'));
  try {
    const bytes = Buffer.alloc(26);
    bytes.write('RIFF');
    bytes.writeUInt32LE(18, 4);
    bytes.write('WEBPVP8L', 8);
    bytes.writeUInt32LE(5, 16);
    bytes[20] = 0x2f;
    bytes.writeUInt32LE(999 | (699 << 14), 21);
    mkdirSync(join(repository, 'maps', 'test@2'), { recursive: true });
    const file = join(repository, 'maps', 'test@2', 'base.webp');
    writeFileSync(file, bytes);
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    git(['init', '--initial-branch=main']);
    git(['add', 'maps/test@2/base.webp']);
    git([
      '-c',
      'user.name=Map fixture',
      '-c',
      'user.email=map@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ]);
    const imageCommit = git(['rev-parse', 'HEAD']).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    expect(() =>
      readMapBackgroundImage({ mapKey: 'test@2', imageRepository: repository, imageCommit: tree }),
    ).toThrow();
    writeFileSync(file, 'uncommitted');
    expect(readMapBackgroundImage({ mapKey: 'test@2', imageRepository: repository, imageCommit })).toEqual({
      mapKey: 'test@2',
      imageCommit,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      width: 1000,
      height: 700,
    });
    expect(() => readMapBackgroundImage({ mapKey: 'test', imageRepository: repository, imageCommit })).toThrow();
    expect(() => readMapBackgroundImage({ mapKey: '../test@2', imageRepository: repository, imageCommit })).toThrow();
  } finally {
    assert.ok(resolve(repository).startsWith(resolve(tmpdir()) + sep + 't4-89-image-'));
    rmSync(repository, { recursive: true });
  }
});

it('AC-P2-28 CLI는 잘못되거나 큰 입력과 DB 설정을 오류 출력에 넣지 않는다', () => {
  for (const input of [
    JSON.stringify({ mapKey: '../test', imageRepository: 'PRIVATE_PATH_MARKER', imageCommit: 'x' }),
    'x'.repeat(4097),
  ]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/map-background.ts', 'register'], {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, DATABASE_URL: 'PRIVATE_DATABASE_MARKER' },
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      '지도 바탕 그림을 등록하지 못했습니다. 명령·표준 입력·이미지 커밋·게시 판·DB 설정을 확인하세요.\n',
    );
  }
}, 15000);
