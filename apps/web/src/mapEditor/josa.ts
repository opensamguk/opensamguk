// 도시 이름처럼 바뀌는 낱말 뒤에 받침에 맞는 조사를 붙인다. 숫자로 끝나면 읽는 소리로 본다.
const DIGIT_FINAL = [true, true, false, true, false, false, true, true, true, false]; // 영 일 이 삼 사 오 육 칠 팔 구
const DIGIT_RIEUL = [false, true, false, false, false, false, false, true, true, false];

function finalSound(word: string): { batchim: boolean; rieul: boolean } {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) {
    const final = code % 28;
    return { batchim: final !== 0, rieul: final === 8 };
  }
  const digit = Number.parseInt(last, 10);
  if (Number.isInteger(digit)) return { batchim: DIGIT_FINAL[digit]!, rieul: DIGIT_RIEUL[digit]! };
  return { batchim: false, rieul: false };
}

export type Josa = '이/가' | '은/는' | '을/를' | '와/과' | '으로/로';

export function josa(word: string, pair: Josa): string {
  const { batchim, rieul } = finalSound(word);
  switch (pair) {
    case '이/가':
      return word + (batchim ? '이' : '가');
    case '은/는':
      return word + (batchim ? '은' : '는');
    case '을/를':
      return word + (batchim ? '을' : '를');
    case '와/과':
      return word + (batchim ? '과' : '와');
    case '으로/로':
      return word + (batchim && !rieul ? '으로' : '로');
  }
}
