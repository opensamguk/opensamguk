import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DisabledReason } from '../ui/DisabledReason';
import { personnelKeys, usePersonnelApi, type AssignmentOfferView } from './contract';
import styles from './Personnel.module.css';
import { euro, iGa, type Notice } from './request';
import { usePersonnelAction } from './usePersonnelAction';
import { usePersonnelEnabled } from './usePersonnelEnabled';

const KINDS = ['offer.respond'] as const;

// 메인 위쪽 발령 제안 상자 (T2-06, D11). 사람 장수가 턴을 쓰지 않고 수락·거절한다.
// 제안이 없거나 인사 기능이 없는 월드면 아무것도 그리지 않는다. 결과 안내는 상자가 사라져도 남는다.
export function OfferBox({ worldId }: { worldId: string }) {
  const api = usePersonnelApi();
  const queryClient = useQueryClient();
  const action = usePersonnelAction({ worldId, kinds: KINDS });
  const personnel = usePersonnelEnabled(worldId);
  const offers = useQuery({
    queryKey: personnelKeys.offers(worldId),
    queryFn: () => api.offers({ worldId }),
    enabled: personnel,
    retry: false,
    // 발령은 엔진이 턴에 만든다. 인사 기능이 없는 월드는 묻지 않고, 서버가 거부해도 다시 묻지 않는다.
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
  });
  const offer = offers.data?.[0];
  // 보내기 직전 제안 목록을 다시 받아 이 제안이 지금 장수에게 아직 열려 있을 때만 보낸다.
  // 계승하면 이전 장수의 발령 제안은 닫히고 새 장수의 목록에 없으므로 예전 화면의 응답은 보내지 않는다.
  const stillOpen = (id: string) => async () => {
    const fresh = await api.offers({ worldId });
    queryClient.setQueryData(personnelKeys.offers(worldId), fresh);
    return fresh.some((row) => row.id === id && row.respond.ok)
      ? null
      : '발령 제안이 바뀌었습니다. 응답을 보내지 않았습니다. 다시 확인하세요.';
  };
  if (!offer && action.notices.length === 0 && !action.busy) return null;
  return (
    <div className={styles.offerStack} data-testid="offer-box">
      <Notices notices={action.notices} />
      {offer ? (
        <OfferCard
          offer={offer}
          busy={action.busy}
          busyLabel={action.busyLabel}
          onRespond={(accept) =>
            void action.submit(
              { kind: 'offer.respond', offerId: offer.id, accept },
              accept ? 'accept' : 'reject',
              stillOpen(offer.id),
            )
          }
        />
      ) : action.busy ? (
        <p className={styles.busy} role="status">
          {action.state.phase === 'sending' ? '발령 응답을 보내는 중입니다.' : '발령 응답을 처리하는 중입니다.'}
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
  busyLabel = '처리 중',
  onRespond,
}: {
  offer: AssignmentOfferView;
  busy: boolean;
  busyLabel?: string;
  onRespond: (accept: boolean) => void;
}) {
  const { issuer, targetCity, expires, rejectCost, respond } = offer;
  // 응답할 수 없으면 서버가 준 이유, 이 화면이 보내는 중이면 처리 중.
  const blocked = busy
    ? busyLabel === '보내는 중'
      ? '요청을 보내는 중입니다.'
      : '요청을 처리하는 중입니다.'
    : respond.ok
      ? null
      : respond.reason;
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
            {busyLabel}
          </span>
        ) : null}
      </div>
    </section>
  );
}
