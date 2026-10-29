// 명령 인자 입력 칸. commands.list가 준 JSON Schema(argsSchema)에서 칸을 만든다.
// 화면은 형식만 돕고, 인자가 맞는지는 서버가 저장·사전 검사 때 다시 본다.

export type ArgField =
  | { key: string; kind: 'city'; label: string }
  | { key: string; kind: 'nation'; label: string }
  | { key: string; kind: 'integer'; label: string; min: number; max: number }
  | { key: string; kind: 'boolean'; label: string; options: [string, string] }
  | { key: string; kind: 'enum'; label: string; options: Array<{ value: string; label: string }> }
  | { key: string; kind: 'color'; label: string }
  | { key: string; kind: 'text'; label: string; maxLength: number };

const LABELS: Record<string, string> = {
  cityKey: '대상 도시',
  nationId: '대상 국가',
  generalId: '대상 장수 번호',
  amount: '수량',
  crewType: '병종 번호',
  unitId: '부곡 번호',
  buy: '사고팔기',
  resource: '자원',
  name: '나라 이름',
  color: '나라 색',
};

const ENUM_LABELS: Record<string, string> = { gold: '금', rice: '쌀' };

interface JsonProperty {
  type?: string;
  enum?: unknown[];
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

export function argFields(schema: unknown): ArgField[] {
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
    if (field.kind === 'city' || field.kind === 'nation' || field.kind === 'integer') {
      const n = Number(raw);
      if (!Number.isInteger(n) || (field.kind === 'integer' && (n < field.min || n > field.max))) {
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
}

// 칸에 넣은 인자를 짧게 적는다. 도시·국가는 지도 데이터의 이름을 쓴다.
export function describeArgs(args: Record<string, unknown>, names: ArgNames): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === 'cityKey' && typeof value === 'number') parts.push(names.city(value) ?? `도시 ${value}`);
    else if (key === 'nationId' && typeof value === 'number') parts.push(names.nation(value) ?? `국가 ${value}`);
    else if (key === 'generalId' && typeof value === 'number' && names.general)
      parts.push(names.general(value) ?? `장수 ${value}`);
    else if (key === 'buy' && typeof value === 'boolean') parts.push(value ? '쌀 사기' : '쌀 팔기');
    else if (key === 'resource' && typeof value === 'string') parts.push(ENUM_LABELS[value] ?? value);
    else if (key === 'target' && value === 'city') parts.push('도시 수비병');
    else parts.push(`${LABELS[key] ?? key} ${String(value)}`);
  }
  return parts.join(' · ');
}
