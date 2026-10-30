const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export type PreparationTarget = 'unit' | 'city';
export function cityPreparationSchema(schema: unknown, enabled: boolean, key: string, target: PreparationTarget) {
  if (!enabled || !['train', 'morale'].includes(key)) return schema;
  const variants = record(schema).anyOf;
  if (!Array.isArray(variants)) return null;
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
