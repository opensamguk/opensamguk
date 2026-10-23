import { useQuery } from '@tanstack/react-query';
import { DisabledReason } from '../ui/DisabledReason';
import { personnelKeys, usePersonnelApi, type AssignmentOfferView } from './contract';
import styles from './Personnel.module.css';
import { euro, iGa, type Notice } from './request';
import { usePersonnelAction } from './usePersonnelAction';

const KINDS = ['offer.respond'] as const;

// 메인 위쪽 발령 제안 상자 (T2-06, D11). 사람 장수가 턴을 쓰지 않고 수락·거절한다.
// 제안이 없거나 인사 기능이 없는 월드면 아무것도 그리지 않는다. 결과 안내는 상자가 사라져도 남는다.
export function OfferBox({ worldId }: { worldId: string }) {
  const api = usePersonnelApi();
  const action = usePersonnelAction({ worldId, kinds: KINDS });
  const offers = useQuery({
    queryKey: personnelKeys.offers(worldId),
    queryFn: () => api.offers({ worldId }),
    retry: false,
    // 발령은 엔진이 턴에 만든다. 서버가 거부하면(인사 기능 이전 월드 등) 다시 묻지 않는다.
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
  });
  const offer = offers.data?.[0];
  if (!offer && action.notices.length === 0 && !action.busy) return null;
  return (
    <div className={styles.offerStack} data-testid="offer-box">
      <Notices notices={action.notices} />
      {offer ? (
        <OfferCard
          offer={offer}
          busy={action.busy}
          onRespond={(accept) =>
            void action.submit({ kind: 'offer.respond', offerId: offer.id, accept }, accept ? 'accept' : 'reject')
          }
        />
      ) : action.busy ? (
        <p className={styles.busy} role="status">
          발령 응답을 처리하는 중입니다.
        </p>
      ) : null}
    </div>
  );
}

export function Notices({ notices }: { notices: Notice[] }) {
  return (
    <>
      {notices.map((notice, i) =>
        notice.tone === 'error' ? (
          <p key={i} className={`${styles.notice} ${styles.noticeError}`} role="alert" data-testid="personnel-notice">
            {notice.text}
          </p>
        ) : (
          <p key={i} className={styles.notice} role="status" data-testid="personnel-notice">
            {notice.text}
          </p>
        ),
      )}
    </>
  );
}

export function OfferCard({
  offer,
  busy,
  onRespond,
}: {
  offer: AssignmentOfferView;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const { issuer, targetCity, expires, rejectCost, respond } = offer;
  // 응답할 수 없으면 서버가 준 이유, 이 화면이 보내는 중이면 처리 중.
  const blocked = busy ? '요청을 처리하는 중입니다.' : respond.ok ? null : respond.reason;
  return (
    <section className={styles.offer} aria-label="발령 제안">
      <p className={styles.offerText}>
        {iGa(issuer.name)} {euro(targetCity.name)} 발령했습니다 · 남은 기한 {expires.monthsLeft}개월, 넘기면 수락
      </p>
      <p className={styles.offerCost}>
        기한은 {expires.year}년 {expires.month}월입니다. 거절하면 공헌이 {rejectCost.dedicationPercent}% 줄어듭니다(−
        <span className="num">{rejectCost.dedication}</span>).
      </p>
      <div className={styles.controls}>
        {blocked === null ? (
          <>
            <button type="button" className={styles.primary} onClick={() => onRespond(true)}>
              수락
            </button>
            <button type="button" className={`${styles.secondary} ${styles.danger}`} onClick={() => onRespond(false)}>
              거절
            </button>
          </>
        ) : (
          <>
            <DisabledReason reason={blocked}>수락</DisabledReason>
            <DisabledReason reason={blocked}>거절</DisabledReason>
          </>
        )}
        {busy ? (
          <span className={styles.busy} role="status">
            처리 중
          </span>
        ) : null}
      </div>
    </section>
  );
}
