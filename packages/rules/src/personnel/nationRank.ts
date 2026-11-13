// core2026 df6c926, app/game-frontend/src/utils/nationFormat.ts. MIT (c) 2025 devsam.
const titles = ['방랑군', '호족', '군벌', '주자사', '주목', '공', '왕', '황제'];
const courtTitles: readonly (readonly string[])[] = [
  ['두목', '부두목'],
  ['영주', '참모'],
  ['군벌', '참모', '비장군', '부참모'],
  ['주자사', '주부', '편장군', '간의대부'],
  ['주목', '태사령', '아문장군', '낭중', '호군', '종사중랑'],
  ['공', '광록대부', '안국장군', '집금오', '파로장군', '소부'],
  ['왕', '광록훈', '좌장군', '상서령', '우장군', '중서령', '전장군', '비서령'],
  ['황제', '승상', '표기장군', '사공', '거기장군', '태위', '위장군', '사도'],
];

export function nationRank(level: number) {
  const offices = courtTitles[level];
  if (!offices) return null;
  return {
    level,
    title: titles[level]!,
    offices: offices.map((title, index) => ({ officerLevel: 12 - index, title })),
  };
}
