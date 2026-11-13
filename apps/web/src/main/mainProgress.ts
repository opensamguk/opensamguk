// 메인 진행 정보 줄에 쓰는 값 (INT-25, 원작 MainView 게임 정보 띠·지도 제목).
// 서버가 이미 주는 world.summary·lobby.worlds·general.mine 값만 쓴다. 못 받은 값은 줄에서 뺀다.

export type Season = '봄' | '여름' | '가을' | '겨울';

// 원작 지도 제목의 계절. 1~3월 봄, 4~6월 여름, 7~9월 가을, 10~12월 겨울.
export function seasonOf(month: number): Season | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return (['봄', '여름', '가을', '겨울'] as const)[Math.floor((month - 1) / 3)]!;
}

export interface ProgressSettings {
  // world.summary.truce. null이면 야간 휴전이 꺼져 있다.
  truce?: unknown;
  // general.mine.creationRules
  generalCreationEnabled?: boolean | undefined;
  npcPlayEnabled?: boolean | undefined;
}

// 사람 장수 수와 정원 (world.summary.quota, INT-26). 정원(max)이 없으면 수만 쓴다.
// 숫자만 받으면(로비 목록의 humanGenerals) 그 수를 쓴다. 아무것도 없으면 null이라 줄에서 뺀다.
export function humanQuotaText(
  quota: { humans: number; max?: number | null | undefined } | number | null | undefined,
): string | null {
  if (quota === null || quota === undefined) return null;
  const { humans, max } = typeof quota === 'number' ? { humans: quota, max: null } : quota;
  const count = humans.toLocaleString('ko-KR');
  return typeof max === 'number' ? `사람 장수 ${count} / 정원 ${max.toLocaleString('ko-KR')}` : `사람 장수 ${count}`;
}

// 켜진 서버 설정 딱지. 응답이 아직 없으면 그 딱지는 뺀다.
export function settingTags({ truce, generalCreationEnabled, npcPlayEnabled }: ProgressSettings): string[] {
  return [
    truce !== null && truce !== undefined ? '야간 휴전' : null,
    generalCreationEnabled === false ? '장수 생성 닫힘' : null,
    npcPlayEnabled === true ? 'NPC 맡기 허용' : null,
  ].filter((tag): tag is string => tag !== null);
}
