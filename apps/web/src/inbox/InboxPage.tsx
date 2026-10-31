import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import diplomacyIcon from '../art/icons/diplomacy.png';
import messagesIcon from '../art/icons/messages.png';
import personnelIcon from '../art/icons/personnel.png';
import { fetchTreatyPage } from '../diplomacy/contract';
import { treatyListBlocked } from '../diplomacy/DiplomacyPage';
import { nationName } from '../diplomacy/TreatyCard';
import { errorCode } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId } from '../game/queries';
import { CAMPAIGN_RELATIONS } from '../personnel/CampaignPanel';
import { personnelKeys, usePersonnelApi } from '../personnel/contract';
import { OfferBox } from '../personnel/OfferBox';
import { useTRPC } from '../trpc';
import { EmptyState, LoadingState } from '../ui/States';
import { incomingTreaties, retinueOffers } from './count';
import styles from './Inbox.module.css';

// 받은 제안함 (INT-20, 시안 X-Inbox). 발령·막부·외교 제안을 한곳에 모은다. 화면만 바꾸며 기존 조회만 쓴다.
// 발령은 메인의 제안 상자를 그대로 쓰고 막부·외교는 수와 요약을 보인 뒤 답하는 화면으로 잇는다.
export function InboxPage() {
  const worldId = useWorldId();
  const home = useHome(worldId);
  const trpc = useTRPC();
  const mine = useQuery(trpc.general.mine.queryOptions({ worldId }));

  let body;
  if (home.isError && errorCode(home.error) === 'NOT_FOUND') body = <NoGeneral worldId={worldId} />;
  else if (home.isError)
    body = <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />;
  else if (!home.data) body = <LoadingState />;
  else
    body = (
      <Inbox
        worldId={worldId}
        hasNation={home.data.nation !== null}
        campaign={Boolean(mine.data?.general && mine.data.creationRules.campaignEnabled)}
      />
    );

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <img className="pixel-art" src={messagesIcon} alt="" width={48} height={48} />
        <h1>받은 제안함</h1>
      </div>
      <p className={styles.lead}>발령·막부·외교 제안을 한곳에서 봅니다.</p>
      {body}
    </section>
  );
}

export function Inbox({ worldId, hasNation, campaign }: { worldId: string; hasNation: boolean; campaign: boolean }) {
  const trpc = useTRPC();
  const api = usePersonnelApi();
  // 메인의 발령 상자와 같은 키다. 주기 조회는 상자가 한다.
  const offers = useQuery({
    queryKey: personnelKeys.offers(worldId),
    queryFn: () => api.offers({ worldId }),
    retry: false,
  });
  const board = useQuery({ ...trpc.campaign.get.queryOptions({ worldId }), enabled: campaign, retry: false });
  // 외교실과 같은 키·같은 조회다. 받은 제안 수는 불러온 쪽만 센다.
  const treaties = useInfiniteQuery({
    queryKey: trpc.treaty.list.infiniteQueryKey({ worldId }),
    queryFn: ({ pageParam, signal }) => fetchTreatyPage(worldId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: hasNation,
    retry: false,
  });

  const loading = offers.isPending || (campaign && board.isPending) || (hasNation && treaties.isPending);
  const retinue = campaign ? retinueOffers(board.data) : [];
  const incoming = hasNation ? incomingTreaties(treaties.data) : [];
  const names = new Map(board.data?.people.map((person) => [person.id, person.name]) ?? []);
  const empty = !loading && (offers.data?.length ?? 0) + retinue.length + incoming.length === 0;
  const treatyBlocked = treaties.isError && treatyListBlocked(treaties.error) !== null;

  return (
    <div className={styles.list}>
      <OfferBox worldId={worldId} />

      {retinue.length > 0 ? (
        <section className={styles.card} aria-labelledby="inbox-retinue">
          <img className="pixel-art" src={personnelIcon} alt="" width={48} height={48} />
          <div className={styles.cardBody}>
            <h2 id="inbox-retinue" className={styles.cardTitle}>
              막부 제안 <span className="num">{retinue.length}</span>
            </h2>
            <ul className={styles.rows}>
              {retinue.map((offer) => (
                <li key={offer.id}>
                  {names.get(offer.masterId) ?? `장수 ${offer.masterId}`}의 {CAMPAIGN_RELATIONS[offer.relation]} 제안
                </li>
              ))}
            </ul>
          </div>
          <Link to="/w/$worldId" params={{ worldId }} hash="campaign-title" className={styles.button}>
            막부에서 답하기
          </Link>
        </section>
      ) : null}
      {campaign && board.isError ? <p className={styles.muted}>막부 제안을 불러오지 못했습니다.</p> : null}

      {incoming.length > 0 ? (
        <section className={styles.card} aria-labelledby="inbox-treaties">
          <img className="pixel-art" src={diplomacyIcon} alt="" width={48} height={48} />
          <div className={styles.cardBody}>
            <h2 id="inbox-treaties" className={styles.cardTitle}>
              외교 제안 <span className="num">{incoming.length}</span>
            </h2>
            <ul className={styles.rows}>
              {incoming.map((treaty) => (
                <li key={treaty.id}>
                  {nationName(treaty.from, treaty.fromNationId)}의 조약 제안 · 응답 기한{' '}
                  {formatYearMonth(treaty.respondBy)}
                </li>
              ))}
            </ul>
            {treaties.hasNextPage ? <p className={styles.muted}>불러온 조약만 셉니다.</p> : null}
          </div>
          <Link to="/w/$worldId/diplomacy" params={{ worldId }} search={{ tab: 'incoming' }} className={styles.button}>
            외교실에서 답하기
          </Link>
        </section>
      ) : null}
      {hasNation && treaties.isError && !treatyBlocked ? (
        <p className={styles.muted}>외교 제안을 불러오지 못했습니다.</p>
      ) : null}

      {loading ? <LoadingState /> : null}
      {empty ? <EmptyState title="받은 제안이 없습니다">발령·막부·외교 제안이 오면 여기에 모입니다.</EmptyState> : null}
    </div>
  );
}
