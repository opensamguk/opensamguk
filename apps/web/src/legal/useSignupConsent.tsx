import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTRPC, useTRPCClient } from '../trpc';
import form from '../auth/AuthForm.module.css';
import {
  consentDocuments,
  documentKeys,
  documentTitles,
  readablePolicy,
  signupPolicyStamp,
  type ConsentDocument,
} from './model';
import styles from './Legal.module.css';

export function useSignupConsent(enabled: boolean, busy: boolean) {
  const trpc = useTRPC(),
    client = useTRPCClient(),
    queries = useQueryClient();
  const current = useQuery({ ...trpc.legal.current.queryOptions(), enabled, staleTime: 0, retry: false });
  const [checked, setChecked] = useState<Partial<Record<ConsentDocument, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const policy = !current.isError && !current.isPending ? readablePolicy(current.data) : null;
  const stamp = !current.isError && !current.isPending ? signupPolicyStamp(current.data) : null;
  const ready =
    stamp !== null && (stamp === 'pending:optional' || consentDocuments.every((doc) => checked[doc] === stamp));

  async function prepare() {
    setError(null);
    if (!ready || current.isFetching) return null;
    try {
      const fresh = await client.legal.current.query();
      queries.setQueryData(trpc.legal.current.queryKey(), fresh);
      if (signupPolicyStamp(fresh) !== stamp) {
        setError('현재 문서가 바뀌었습니다. 새 본문을 확인하고 다시 동의하세요.');
        return null;
      }
      const readable = readablePolicy(fresh);
      if (!readable) return stamp === 'pending:optional' ? {} : null;
      return {
        consents: { terms: readable.terms.version, privacy: readable.privacy.version },
      };
    } catch {
      setError('현재 문서를 확인하지 못했습니다. 다시 조회한 뒤 가입하세요.');
      return null;
    }
  }

  const fields = enabled ? (
    <fieldset className={styles.consents} disabled={busy}>
      <legend>필수 문서 확인</legend>
      {current.isError ? (
        <>
          <p role="alert">현재 문서를 읽지 못했습니다.</p>
          <button
            type="button"
            className={form.submit}
            disabled={current.isFetching}
            onClick={() => void current.refetch()}
          >
            문서 다시 조회
          </button>
        </>
      ) : current.isPending ? (
        <p role="status">현재 문서를 확인하고 있습니다…</p>
      ) : !policy ? (
        <p role="status">
          {stamp === 'pending:optional'
            ? '개발 환경의 비필수 가입입니다. 승인된 문서를 준비하고 있습니다.'
            : '승인된 본문을 준비하고 있습니다. 가입은 준비 뒤 열립니다.'}
        </p>
      ) : (
        consentDocuments.map((docType) => {
          const document = policy[documentKeys[docType]];
          return (
            <div key={docType}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={checked[docType] === policy.stamp}
                  onChange={(event) => {
                    const accepted = event.target.checked;
                    setChecked((before) => ({ ...before, [docType]: accepted ? policy.stamp : '' }));
                  }}
                />
                <span>
                  {documentTitles[docType]} {document.version}에 동의합니다.
                </span>
              </label>
              <Link
                className={styles.link}
                to={docType === 'TERMS' ? '/legal/terms' : '/legal/privacy'}
                target="_blank"
                rel="noopener noreferrer"
              >
                {documentTitles[docType]} 별도 창에서 읽기
              </Link>
              <details>
                <summary>{documentTitles[docType]} 현재 본문</summary>
                <p>
                  시행{' '}
                  <time dateTime={document.effectiveAt}>
                    {new Date(document.effectiveAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                  </time>
                </p>
                <div className={styles.body}>{document.bodyText}</div>
              </details>
            </div>
          );
        })
      )}
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  ) : null;
  return { fields, ready: ready && !current.isFetching, prepare };
}
