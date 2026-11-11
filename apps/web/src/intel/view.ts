import { formatYearMonth } from '../game/gameDate';
import type { IntelCrewBand, IntelCrewTypes, IntelLevel, IntelRecordView, IntelTech } from './types';

// 첩보 기록 표시 함수(T4-13 §1.5). 서버가 투영한 값만 글로 바꾼다. 구간 경계·기간 판정은 서버 정책이다.

export const OWNER_CHANGED = '지금은 다른 나라 도시';
export const RECORD_NOTE = '기록은 첩보한 때의 값이며 다시 첩보하기 전까지 바뀌지 않습니다.';

const number = (value: number) => value.toLocaleString('ko-KR');

export function ageLabel(ageMonths: number) {
  return ageMonths <= 0 ? '이번 달' : `${ageMonths}개월 전`;
}

const LEVEL_LABELS: Record<IntelLevel, string> = { 1: '많이', 2: '어느 정도', 3: '소문' };
export const levelLabel = (level: IntelLevel) => LEVEL_LABELS[level];

// 받은 구간을 그대로 그린다. 위가 열리면 min 이상, 같은 값이면 한 값이다.
export function crewText({ min, max }: IntelCrewBand) {
  if (max === null) return `${number(min)} 이상`;
  if (min === max) return number(min);
  return `${number(min)}~${number(max)}`;
}

const TECH_LABELS: Record<IntelTech, string> = {
  overwhelming: '압도',
  ahead: '우위',
  even: '대등',
  behind: '열위',
  far_behind: '미미',
};
export const techLabel = (tech: IntelTech) => TECH_LABELS[tech];

export function crewTypesText(list: IntelCrewTypes) {
  if (list.length === 0) return '장수 없음';
  return list.map((row) => `${row.name} ${number(row.generals)}`).join(' · ');
}

export type MissingColumn = 'domestic' | 'crewTypes' | 'tech';

// 기록되지 않은 칸의 이유. 지금 값으로 채우지 않고 —와 이 문구를 보인다(IC-4).
export function missingReason(record: Pick<IntelRecordView, 'owner'>, column: MissingColumn) {
  if (column === 'domestic') return '정보를 어느 정도 이상 얻었을 때만 기록됩니다';
  if (column === 'tech' && record.owner === null) return '공백지라 비교하지 않습니다';
  return '정보를 많이 얻었을 때만 기록됩니다';
}

export function recordedAtText(record: Pick<IntelRecordView, 'year' | 'month' | 'ageMonths'>) {
  return `${formatYearMonth({ year: record.year, month: record.month })} · ${ageLabel(record.ageMonths)}`;
}

// 기록 당시 주인과 지금 주인이 다른가. 지금 주인을 모르면(지도에 없는 도시) 표시하지 않는다.
export function ownerChanged(record: Pick<IntelRecordView, 'owner'>, currentNationId: number | null | undefined) {
  if (currentNationId === undefined) return false;
  return (record.owner?.id ?? null) !== currentNationId;
}

export const trustText = (trust: number) => (Math.round(trust * 10) / 10).toFixed(1);
