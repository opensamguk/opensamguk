import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import { AccountFrame } from '../account/AccountParts';
import form from '../auth/AuthForm.module.css';
import { documentKeys, documentTitles, readablePolicy, type ConsentDocument } from './model';
import styles from './Legal.module.css';

export function LegalDocumentPage({ docType }: { docType: ConsentDocument }) {
  const trpc = useTRPC();
  const current = useQuery({ ...trpc.legal.current.queryOptions(), staleTime: 0, retry: false });
  const policy = !current.isError ? readablePolicy(current.data) : null;
  const document = policy?.[documentKeys[docType]];
  return (
    <AccountFrame title={documentTitles[docType]}>
      {current.isError ? (
        <>
          <p role="alert">본문을 읽지 못했습니다. 다시 조회하세요.</p>
          <button
            type="button"
            className={form.submit}
            disabled={current.isFetching}
            onClick={() => void current.refetch()}
          >
            다시 조회
          </button>
        </>
      ) : current.isPending ? (
        <p role="status">본문을 확인하고 있습니다…</p>
      ) : !document ? (
        <p role="status">승인된 본문을 준비하고 있습니다.</p>
      ) : (
        <>
          <p>
            판 {document.version} · 시행{' '}
            <time dateTime={document.effectiveAt}>
              {new Date(document.effectiveAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
            </time>
          </p>
          <div className={styles.body}>{document.bodyText}</div>
        </>
      )}
    </AccountFrame>
  );
}
