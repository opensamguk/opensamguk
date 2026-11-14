import { koreanParticle, logPartsRecord, readLogParts, type LogPart } from '@opensamguk/shared';
import type { ReputationEventRecord } from '@opensamguk/rules';

export function reputationRecord(event: ReputationEventRecord): {
  text?: string;
  parts?: LogPart[] | null;
  partsVersion?: number | null;
} {
  const { name, city } = event.data;
  const particle = koreanParticle(name, '이/가');
  const endings = {
    conquest: ' 점령을 이끌었다.',
    victory: ' 교전에서 이겼다.',
    defeat: ' 교전에서 졌다.',
    domestic: ' 내정 목표를 채웠다.',
    betrayal: ' 소속이나 조약의 약속을 끊었다.',
  };
  const parts: LogPart[] = [
    { t: 'general', id: event.generalId, name },
    { t: 'text', v: particle },
  ];
  if (city) parts.push({ t: 'text', v: ' ' }, { t: 'city', key: city.cityKey, name: city.name });
  parts.push({ t: 'text', v: endings[event.kind] });
  return logPartsRecord(name + particle + (city ? ` ${city.name}` : '') + endings[event.kind], parts);
}

export const nationHistoryKind = ['command', 'intel', 'legacy'] as const;
export function nationHistoryEvents(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const legacy = Array.isArray(record.events) ? record.events : [];
  const structured = Array.isArray(record.structuredEvents) ? record.structuredEvents : [];
  return legacy.flatMap((text, ordinal) => {
    if (typeof text !== 'string') return [];
    const entry = structured.find((value) => value && typeof value === 'object' && value.ordinal === ordinal);
    if (
      !entry ||
      typeof entry.text !== 'string' ||
      entry.text !== text ||
      (entry.visibility !== 'nation' && entry.visibility !== 'public')
    )
      return [{ ordinal, kind: 'legacy', text, parts: null, partsVersion: null }];
    return [
      {
        ordinal,
        kind: nationHistoryKind.includes(entry.kind) ? entry.kind : 'legacy',
        text,
        ...readLogParts(entry.parts, entry.partsVersion),
      },
    ];
  });
}
