import { logPartsRecord } from '@opensamguk/shared';
import type { Prisma } from '@opensamguk/db';
import type { CommandResult, Failure } from '@opensamguk/rules';

export function storedLog(text: string, parts?: unknown) {
  const row = logPartsRecord(text, parts);
  return { text: row.text, ...(row.parts ? { parts: row.parts as Prisma.InputJsonValue, partsVersion: 1 } : {}) };
}

export function commandLogLines(result: CommandResult | Failure) {
  if ('code' in result)
    return [{ kind: 'failure', code: result.code, ...storedLog(result.message, [{ t: 'text', v: result.message }]) }];
  return result.logs.flatMap((log) => {
    if (!log.text.includes('\n') && !log.text.includes('\r'))
      return [{ kind: log.kind, ...storedLog(log.text, log.parts) }];
    return log.text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((text) => ({ kind: log.kind, text }));
  });
}
