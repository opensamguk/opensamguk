// 명령 인자 입력 칸. commands.list가 준 JSON Schema(argsSchema)에서 칸을 만든다.
// 화면은 형식만 돕고, 인자가 맞는지는 서버가 저장·사전 검사 때 다시 본다.
import type { UnitInfo } from '../battleSim/unitChoices';
import { displayName } from '../game/names';

export type ArgField =
  | { key: string; kind: 'city'; label: string }
  | { key: string; kind: 'nation'; label: string }
  | { key: string; kind: 'integer'; label: string; min: number; max: number }
  | { key: string; kind: 'unit'; label: string; options: Array<{ value: string; label: string }> }
  | { key: string; kind: 'boolean'; label: string; options: [string, string] }
  | {
      key: string;
      kind: 'enum';
      label: string;
      options: Array<{ value: string; label: string }>;
      philosophyEffects?: Record<string, { benefits: string[]; drawbacks: string[] }>;
    }
  | { key: string; kind: 'color'; label: string }
  | { key: string; kind: 'text'; label: string; maxLength: number };

const LABELS: Record<string, string> = {
  cityKey: '대상 도시',
  nationId: '대상 국가',
  generalId: '대상 장수 번호',
  amount: '수량',
  crewType: '병종',
  srcArmType: '기존 병종 계열',
  destArmType: '전환할 병종 계열',
  unitId: '부곡 번호',
  buy: '사고팔기',
  resource: '자원',
  name: '나라 이름',
  color: '나라 색',
  philosophy: '국가 성향',
  slot: '장비 칸',
  itemKey: '매매할 장비',
};

const ENUM_LABELS: Record<string, string> = { gold: '금', rice: '쌀', horse: '명마', weapon: '무기', book: '서적' };

interface JsonProperty {
  type?: string;
  enum?: unknown[];
  'x-philosophy-effects'?: Record<string, { benefits: string[]; drawbacks: string[] }>;
  pattern?: string;
  maximum?: number;
  exclusiveMinimum?: number;
  minimum?: number;
  maxLength?: number;
  not?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// units는 월드 병종표의 병종이다 (T4-86, worldUnits().all). 불러오는 중·오류면 빈 목록이라 병종 칸 선택지가 빈다.
export function argFields(
  schema: unknown,
  units: readonly UnitInfo[],
  armTypes: Readonly<Record<string, string>> = {},
): ArgField[] {
  const properties = asRecord(asRecord(schema).properties);
  const fields: ArgField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = raw as JsonProperty;
    // { not: {} }는 넣으면 안 되는 인자다 (무작위 임관의 nationId).
    if (prop.not !== undefined) continue;
    const label = LABELS[key] ?? key;
    if (prop.type === 'integer') {
      if (key === 'cityKey') fields.push({ key, kind: 'city', label });
      else if (key === 'nationId') fields.push({ key, kind: 'nation', label });
      // 병종은 번호를 치지 않고 이름으로 고른다. 장수 병종(armType > 0)은 모집 조건과 관계없이 모두 둔다.
      // 지금 조건을 못 갖춘 병종도 예약할 수 있고 사전 검사가 경고한다.
      else if (key === 'srcArmType' || key === 'destArmType')
        fields.push({
          key,
          kind: 'unit',
          label,
          options: Object.entries(armTypes)
            .filter(([id]) => Number(id) > 0)
            .map(([value, label]) => ({ value, label })),
        });
      else if (key === 'crewType')
        fields.push({
          key,
          kind: 'unit',
          label,
          options: units
            .filter((unit) => unit.armType > 0)
            .map((unit) => ({ value: String(unit.id), label: unit.name })),
        });
      else
        fields.push({
          key,
          kind: 'integer',
          label,
          min: prop.exclusiveMinimum !== undefined ? prop.exclusiveMinimum + 1 : (prop.minimum ?? 0),
          max: prop.maximum ?? 2_147_483_647,
        });
    } else if (prop.type === 'boolean') {
      fields.push({ key, kind: 'boolean', label, options: key === 'buy' ? ['쌀 사기', '쌀 팔기'] : ['예', '아니오'] });
    } else if (prop.type === 'string' && Array.isArray(prop.enum)) {
      fields.push({
        key,
        kind: 'enum',
        label,
        ...(prop['x-philosophy-effects'] ? { philosophyEffects: prop['x-philosophy-effects'] } : {}),
        options: prop.enum.map((value) => ({
          value: String(value),
          label: ENUM_LABELS[String(value)] ?? String(value),
        })),
      });
    } else if (prop.type === 'string' && prop.pattern?.startsWith('^#')) {
      fields.push({ key, kind: 'color', label });
    } else if (prop.type === 'string') {
      fields.push({ key, kind: 'text', label, maxLength: prop.maxLength ?? 30 });
    }
  }
  return fields;
}

export function requiredKeys(schema: unknown): string[] {
  const required = asRecord(schema).required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : [];
}

// 입력 칸의 문자열 값을 서버에 보낼 인자로 바꾼다. 빠진 필수 값은 missing에 담는다.
export function buildArgs(
  fields: ArgField[],
  required: string[],
  values: Record<string, string>,
): { args: Record<string, unknown>; missing: string[] } {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const raw = (values[field.key] ?? '').trim();
    if (raw === '') {
      if (required.includes(field.key)) missing.push(field.label);
      continue;
    }
    if (field.kind === 'city' || field.kind === 'nation' || field.kind === 'integer' || field.kind === 'unit') {
      const n = Number(raw);
      if (
        !Number.isInteger(n) ||
        (field.kind === 'integer' && (n < field.min || n > field.max)) ||
        (field.kind === 'unit' && !field.options.some((option) => option.value === raw))
      ) {
        missing.push(field.label);
        continue;
      }
      args[field.key] = n;
    } else if (field.kind === 'boolean') {
      args[field.key] = raw === 'true';
    } else {
      args[field.key] = raw;
    }
  }
  return { args, missing };
}

export interface ArgNames {
  city: (key: number) => string | undefined;
  nation: (id: number) => string | undefined;
  // 국가 칸(T2-06)만 넘긴다. 없으면 장수는 번호로 적는다.
  general?: ((id: number) => string | undefined) | undefined;
  // 월드 병종표의 병종 이름 (T4-86). 없거나 못 읽었으면 병종은 번호로 적는다.
  unit?: ((id: number) => string | undefined) | undefined;
  armType?: ((id: number) => string | undefined) | undefined;
  // 장비매매의 품목 이름 (equipment.mine). 못 읽었으면 품목 키를 적는다.
  equipment?: ((itemKey: string) => string | undefined) | undefined;
}

// 칸에 넣은 인자를 짧게 적는다. 도시·국가는 지도 데이터의 이름을 쓴다.
export function describeArgs(args: Record<string, unknown>, names: ArgNames): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === 'cityKey' && typeof value === 'number') parts.push(names.city(value) ?? `도시 ${value}`);
    else if (key === 'nationId' && typeof value === 'number') parts.push(names.nation(value) ?? `국가 ${value}`);
    else if (key === 'generalId' && typeof value === 'number' && names.general)
      parts.push(displayName(names.general(value) ?? `장수 ${value}`));
    else if (key === 'crewType' && typeof value === 'number') parts.push(names.unit?.(value) ?? `병종 ${value}`);
    else if ((key === 'srcArmType' || key === 'destArmType') && typeof value === 'number')
      parts.push(names.armType?.(value) ?? `병종 계열 ${value}`);
    else if (key === 'buy' && typeof value === 'boolean') parts.push(value ? '쌀 사기' : '쌀 팔기');
    else if (key === 'resource' && typeof value === 'string') parts.push(ENUM_LABELS[value] ?? value);
    // 장비매매는 원작 요약처럼 칸 이름(명마·무기·서적)과 장비 이름을 적고, none은 판매다.
    else if (key === 'slot' && typeof value === 'string') parts.push(ENUM_LABELS[value] ?? value);
    else if (key === 'itemKey' && typeof value === 'string')
      parts.push(value === 'none' ? '판매' : (names.equipment?.(value) ?? `장비 ${value}`));
    else if (key === 'target' && value === 'city') parts.push('도시 수비병');
    else parts.push(`${LABELS[key] ?? key} ${String(value)}`);
  }
  return parts.join(' · ');
}

// 서버가 예턴 칸에 실어 준 대상 이름 (turns.get 칸의 targets, INT-26). null은 서버가 이름을 주지 않은 대상이다(안개·없어진 장수).
export interface SlotTargets {
  city?: string | null | undefined;
  nation?: string | null | undefined;
  general?: string | null | undefined;
}

// 칸의 대상 이름을 먼저 쓰고, 없으면 지도·장수 목록에서 찾는다. 장수 이름을 끝내 모르면 번호로 적는다.
// 개인 칸에도 장수 대상(등용·선양)이 있어 장수 이름 찾기를 늘 둔다.
export function withTargets(names: ArgNames, targets: SlotTargets | undefined): ArgNames {
  if (!targets) return names.general ? names : { ...names, general: () => undefined };
  return {
    ...names,
    city: (key) => targets.city ?? names.city(key),
    nation: (id) => targets.nation ?? names.nation(id),
    general: (id) => targets.general ?? names.general?.(id),
  };
}
