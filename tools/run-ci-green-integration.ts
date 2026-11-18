import { spawnSync } from 'node:child_process';
import { pnpmCli } from './node-cli';

// AC-INT-28: 기존 연결의 인증 정보는 유지하고 승인된 전용 DB만 사용한다.
const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error('TEST_DATABASE_URL이 필요합니다.');
const url = new URL(source);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5561')
  throw new Error('127.0.0.1:5561의 기존 PostgreSQL 연결이 필요합니다.');
url.pathname = '/opensamguk_ci_green_r2_test';
const env = { ...process.env, TEST_DATABASE_URL: url.href };
const result = spawnSync(...pnpmCli(['test:int'], env), { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// 실패한 하위 명령의 진단에도 연결 문자열을 남기지 않는다.
const redact = (output: string) => output.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g, '[DB 연결 생략]');
process.stdout.write(redact(result.stdout ?? ''));
process.stderr.write(redact(result.stderr ?? ''));
if (result.error) throw new Error('CI 복구 통합 시험을 실행하지 못했습니다.');
process.exitCode = result.status ?? 1;
