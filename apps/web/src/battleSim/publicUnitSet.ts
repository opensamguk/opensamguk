// E2 (docs/architecture/package-boundaries.md): 저장소에 커밋된 공개 병종표 하나만 상대 경로로 읽는다.
// 사용자 입력이 아니며 네트워크로 받지 않는다. 출처 core2026 df6c926 (MIT), resources/NOTICE.md.
// eslint.config.js가 이 파일에서만 opensamguk/no-cross-package-relative를 끈다.
import basic from '../../../../resources/unitset/basic.json';

// Worker가 unitSetSchema로 다시 검사한다. 화면은 이름과 기본 병종만 쓴다.
export const PUBLIC_UNIT_SET: unknown = basic;
export const UNIT_SET_ID: string = basic.id;
export const DEFAULT_CREW_TYPE_ID: number = basic.defaultCrewTypeId;
export const UNIT_CHOICES: ReadonlyArray<{ id: number; armType: number; name: string }> = basic.crewTypes.map(
  (unit) => ({ id: unit.id, armType: unit.armType, name: unit.name }),
);

export function unitName(id: number): string {
  return UNIT_CHOICES.find((unit) => unit.id === id)?.name ?? String(id);
}
