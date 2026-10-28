#!/bin/sh
set -eu

fail() {
  printf '%s\n' '실행 비밀 파일과 명령을 확인하세요.' >&2
  exit 1
}

# 비밀값이 컨테이너 설정이나 명령 인자에 남는 경로를 받지 않는다.
[ "${DATABASE_URL+x}" != x ] || fail
[ "${MAIL_API_KEY+x}" != x ] || fail
[ "${RESEND_API_KEY+x}" != x ] || fail
[ "$#" -gt 0 ] || fail
[ "${MAIL_API_KEY_FILE:-/run/secrets/mail_api_key}" = /run/secrets/mail_api_key ] || fail

# stdout은 셸의 환경값으로만 받는다. 오류에는 원문·파일 경로를 쓰지 않는다.
DATABASE_URL="$(node --input-type=module <<'NODE'
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
const failure=()=>{process.stderr.write('실행 비밀 파일과 명령을 확인하세요.\n');process.exit(1);};
function secret(name) {
  let fd;
  try {
    const directory=lstatSync('/run/secrets');
    if(!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode&0o777)!==0o700 || directory.uid!==process.getuid())throw Error();
    fd=openSync('/run/secrets/'+name,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile() || (stat.mode&0o777)!==0o600 || stat.uid!==process.getuid() || stat.size<1 || stat.size>4096)throw Error();
    const bytes=readFileSync(fd);
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(/[\u0000\r\n]/.test(value) || !value.trim())throw Error();
    return value;
  } catch {failure();}
  finally {if(fd!==undefined)closeSync(fd);}
}
try {
  const value=secret('database_url');
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length<2)throw Error();
  if(process.env.MAIL_TRANSPORT==='resend')secret('mail_api_key');
  process.stdout.write(value);
}catch {failure();}
NODE
)" || exit 1
export DATABASE_URL
if [ "${MAIL_TRANSPORT:-}" = resend ]; then
  MAIL_API_KEY_FILE=/run/secrets/mail_api_key
  export MAIL_API_KEY_FILE
fi
exec "$@"
