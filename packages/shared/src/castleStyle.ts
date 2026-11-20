// 지역 번호 표는 삼국지10 지도 기준이다. 이름 표가 지역 번호보다 먼저 적용된다.
export const CASTLE_STYLES = [
  'central',
  'hebei',
  'liang',
  'jing',
  'yang',
  'ba-shu',
  'nanzhong',
  'east-goguryeo',
  'east-buyeo',
  'east-eupru',
  'east-okjeo-ye',
  'east-mahan',
  'east-jinbyeon',
  'east-wa',
  'tribe-xiongnu',
  'tribe-xianbei',
  'tribe-wuhuan',
  'tribe-qiang',
  'tribe-di',
  'tribe-nanman',
  'tribe-shanyue',
  'tribe-yizhou',
] as const;
export type CastleStyle = (typeof CASTLE_STYLES)[number];
export const REGION_GROUPS: Readonly<Record<number, CastleStyle>> = {
  1: 'central',
  2: 'central',
  4: 'central',
  5: 'central',
  6: 'central',
  3: 'hebei',
  12: 'hebei',
  13: 'hebei',
  11: 'liang',
  7: 'jing',
  8: 'yang',
  9: 'ba-shu',
  10: 'nanzhong',
  14: 'nanzhong',
};
/** 이민족 본거 그림(사용자 2026-11-14: "이민족 아이콘은 해당 이민족이랑 지역마다 다르게"). */
export const TRIBE_SPRITES: Readonly<Record<string, CastleStyle>> = {
  흉노: 'tribe-xiongnu',
  선비: 'tribe-xianbei',
  오환: 'tribe-wuhuan',
  강: 'tribe-qiang',
  저: 'tribe-di',
  남만: 'tribe-nanman',
  산월: 'tribe-shanyue',
  // 이주(夷洲): 원주민의 섬. 손권이 사람을 사로잡으러 원정했다(『資治通鑑』 卷71·72). 사용자 2026-11-14: "이주는 이로 두자".
  이주: 'tribe-yizhou',
};
const EAST_GROUPS: ReadonlyArray<readonly [CastleStyle, readonly string[]]> = [
  ['east-goguryeo', ['국내성', '졸본', '환도성']],
  ['east-buyeo', ['부여']],
  ['east-eupru', ['읍루']],
  ['east-okjeo-ye', ['옥저', '북옥저', '동예', '불내', '맥국', '화려', '부조']],
  ['east-mahan', ['목지국', '백제국', '건마국', '신미', '모로비리', '주호']],
  [
    'east-jinbyeon',
    ['사로국', '구야국', '안야', '사벌', '조문', '다벌', '초팔', '고자미동', '우시산', '감문', '골벌', '근기'],
  ],
  [
    'east-wa',
    [
      '노국',
      '대마국',
      '일지국',
      '이도국',
      '투마국',
      '지유국',
      '야마타이국',
      '구노',
      '말로국',
      '불미국',
      '이사국',
      '파리국',
    ],
  ],
];
/** 동이 나라 이름 → 지역 그림. 읍루 그림이 없으면 옥저·동예 그림을 쓴다. */
export const EAST_SPRITES: ReadonlyMap<string, CastleStyle> = new Map(
  EAST_GROUPS.flatMap(([sprite, names]) => names.map((name) => [name, sprite] as const)),
);
export function castleStyle(place?: { name?: string | undefined; region?: number | undefined }): CastleStyle {
  const special = place?.name && (TRIBE_SPRITES[place.name] ?? EAST_SPRITES.get(place.name));
  if (special) return special;
  return (place?.region === undefined ? undefined : REGION_GROUPS[place.region]) ?? 'central';
}
