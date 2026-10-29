import { createHash } from 'node:crypto';
import type { PrismaClient } from '@opensamguk/db';
import { hasLegalBodies, type LegalPolicy } from './policy';

export class LegalPublicationError extends Error {
  constructor(readonly kind: 'changed' | 'legacy' | 'storage') {
    super(`약관 발행 기록을 확인하세요 (${kind}).`);
    this.name = 'LegalPublicationError';
  }
}

/** 승인 소스의 판을 시작 전에 고정한다. 과거 동의의 본문을 추측하거나 덮어쓰지 않는다. */
export async function bindLegalPolicy(db: PrismaClient, policy: LegalPolicy | null) {
  // 본문 없는 기존 신뢰 생성자 fixture는 발행으로 세지 않는다.
  if (!policy || !hasLegalBodies(policy)) return;
  try {
    await db.$transaction(async (tx) => {
      // 두 시작자가 같은 순서로 유일키를 잡게 한다.
      for (const [docType, document] of [
        ['TERMS', policy.terms],
        ['PRIVACY', policy.privacy],
      ] as const) {
        const entry = {
          docType,
          version: document.version,
          effectiveAt: new Date(document.effectiveAt),
          bodySha256: createHash('sha256').update(document.bodyText, 'utf8').digest('hex'),
        };
        const inserted = await tx.legalDocumentVersion.createMany({ data: entry, skipDuplicates: true });
        const stored = await tx.legalDocumentVersion.findUnique({
          where: { docType_version: { docType, version: entry.version } },
        });
        if (
          !stored ||
          stored.bodySha256 !== entry.bodySha256 ||
          stored.effectiveAt.getTime() !== entry.effectiveAt.getTime()
        )
          throw new LegalPublicationError('changed');
        if (inserted.count === 1 && (await tx.consentRecord.count({ where: { docType, version: entry.version } })) > 0)
          throw new LegalPublicationError('legacy');
      }
    });
  } catch (error) {
    if (error instanceof LegalPublicationError) throw error;
    throw new LegalPublicationError('storage');
  }
}
