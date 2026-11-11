import type { IntelRecordsResponse, IntelRecordView } from '../types';

// 서버가 이미 투영한 모양(T4-12 §2.2). 병력은 승인 구간이고 정확한 값은 없다.
const base = {
  tick: 0,
  year: 191,
  month: 2,
  ageMonths: 3,
  owner: { id: 2, name: '위', color: '#1f4e9c' },
  population: 12_345,
  populationMax: 30_000,
  trust: 72.5,
  generals: 3,
  crew: { min: 5_000, max: 9_999 },
} satisfies Partial<IntelRecordView>;

export function levelOne(overrides: Partial<IntelRecordView> = {}): IntelRecordView {
  return {
    ...base,
    cityKey: 10,
    tick: 300,
    level: 1,
    domestic: {
      agriculture: 4_000,
      agricultureMax: 8_000,
      commerce: 3_000,
      commerceMax: 6_000,
      security: 500,
      securityMax: 1_000,
      defence: 2_000,
      defenceMax: 4_000,
      wall: 1_500,
      wallMax: 3_000,
    },
    crewTypes: [
      { crewType: 1, name: '창병', generals: 2 },
      { crewType: 2, name: '궁병', generals: 1 },
    ],
    tech: 'ahead',
    ...overrides,
  };
}

export function levelThree(overrides: Partial<IntelRecordView> = {}): IntelRecordView {
  return { ...base, cityKey: 20, tick: 100, year: 190, month: 12, ageMonths: 5, level: 3, ...overrides };
}

// 선택 칸은 기록에 없으면 키 자체가 없다.
export function without(record: IntelRecordView, ...keys: ('domestic' | 'crewTypes' | 'tech')[]): IntelRecordView {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

export const cities = [
  { key: 10, name: '허창', nationId: 2 },
  { key: 20, name: '완', nationId: 3 },
  { key: 30, name: '업', nationId: 1 },
];

export const enabled = (items: IntelRecordView[]): IntelRecordsResponse => ({ enabled: true, items, alerts: [] });
