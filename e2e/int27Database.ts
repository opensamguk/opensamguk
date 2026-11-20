export function assertInt27Database(target: URL) {
  if (target.hostname !== '127.0.0.1' || target.port !== '5561' || target.pathname !== '/opensamguk_int27_test')
    throw Error('INT-27 시험은 127.0.0.1:5561/opensamguk_int27_test만 사용합니다.');
}
