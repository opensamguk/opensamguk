import type { AppRouter } from '@opensamguk/server/router';
import type { InfiniteData } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { TreatyItem, TreatyListPage } from '../diplomacy/contract';
import { joinTreatyPages, treatiesForTab } from '../diplomacy/DiplomacyPage';
import type { AssignmentOfferView } from '../personnel/contract';

export type CampaignBoard = inferRouterOutputs<AppRouter>['campaign']['get'];

// 받은 제안함이 세는 것 (INT-20). 이미 받은 조회 값만 쓴다. 새 API를 부르지 않는다.
export const retinueOffers = (board: CampaignBoard | undefined) =>
  board?.offers.filter((offer) => offer.personId === board.actorId && offer.status === 'PENDING') ?? [];

export const incomingTreaties = (pages: InfiniteData<TreatyListPage> | undefined): TreatyItem[] =>
  pages ? treatiesForTab(joinTreatyPages(pages.pages), 'incoming') : [];

export function countInbox({
  offers,
  board,
  treaties,
}: {
  offers: readonly AssignmentOfferView[] | undefined;
  board: CampaignBoard | undefined;
  treaties: InfiniteData<TreatyListPage> | undefined;
}): number {
  return (offers?.length ?? 0) + retinueOffers(board).length + incomingTreaties(treaties).length;
}
