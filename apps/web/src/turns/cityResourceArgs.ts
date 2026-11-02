const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export type PreparationTarget = 'unit' | 'city';
// 서버 schema에 도시 수비병 갈래(target: 'city')가 있는지 본다. 어떤 명령이 갈래를 갖는지는 서버 명령 계약이 정하고
// 화면은 명령 키 목록을 따로 두지 않는다 (T4-92·AC-P2-35 레이어 분리).
export function hasCityBranch(schema: unknown): boolean {
  const variants = record(schema).anyOf;
  return (
    Array.isArray(variants) &&
    variants.some((value) => record(record(record(value).properties).target).const === 'city')
  );
}
// 고른 갈래의 입력 schema. 도시 자원 판이 아니거나(월드 규칙을 받기 전 포함) 알 수 없는 union이면 null로 입력을 막는다.
// 도시 수비병을 골랐는데 서버 schema에 그 갈래가 없어도 null이다.
export function cityPreparationSchema(schema: unknown, enabled: boolean, target: PreparationTarget) {
  const variants = record(schema).anyOf;
  if (!Array.isArray(variants)) return enabled && target === 'city' ? null : schema;
  if (!enabled || !hasCityBranch(schema)) return null;
  const selected = variants.find((value) => {
    const properties = record(record(value).properties);
    return target === 'city' ? record(properties.target).const === 'city' : 'unitId' in properties;
  });
  if (!selected) return null;
  if (target === 'unit') return selected;
  const branch = record(selected),
    properties = { ...record(branch.properties) };
  delete properties.target;
  return {
    ...branch,
    properties,
    required: Array.isArray(branch.required) ? branch.required.filter((key) => key !== 'target') : [],
  };
}
export function cityPreparationNote(enabled: boolean, key: string, target: PreparationTarget): string | null {
  if (!enabled) return null;
  if (key === 'recruit' || key === 'conscript')
    return '현재 도시의 금과 인구를 써서 도시 수비병을 모집합니다. 부곡에 직접 충원하지 않습니다. 비용과 민심은 서버 사전 검사로 확인합니다.';
  if (key === 'train' || key === 'morale')
    return target === 'city'
      ? '현재 도시의 금을 써서 고른 병종의 도시 수비병을 준비합니다. 개인 예약 한 칸을 씁니다.'
      : '기존 부곡을 준비하며 개인 금을 씁니다. 도시 금과 수비병은 바꾸지 않습니다.';
  if (key === 'form_unit') return '병력이 없는 부곡을 편성합니다. 도시 병력 배속은 권한자가 별도로 처리합니다.';
  return null;
}
