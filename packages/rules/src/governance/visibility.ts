import type { WorldView } from '../model/world';
import { TICKS_PER_MONTH } from '../clock/constants';
import { decideGovernanceAction } from './actions';
import { GOVERNANCE_OFFICES } from './config';
import type { GovernanceMovement } from './ledger';
import { governanceRealmIndex } from './realm';
import { reconcileGovernance } from './reconcile';

function viewerContext(world: WorldView, viewerId: number | null, tick: number) {
  const state = reconcileGovernance(world, tick),
    gov = state.governance!;
  const index = governanceRealmIndex(state, gov, tick);
  const general = viewerId === null ? undefined : state.generals[viewerId];
  const nationId = general?.nationId ?? null;
  const monarch = nationId !== null && index.alive.has(nationId) && index.rulers.get(nationId) === viewerId;
  const emperor = viewerId !== null && gov.throne.emperorGeneralId === viewerId;
  const roles = {
    monarch,
    emperor,
    chancellor: viewerId !== null && gov.court.chancellor?.generalId === viewerId,
    grandMarshal: viewerId !== null && gov.court.grandMarshal?.generalId === viewerId,
    minister: viewerId !== null && gov.court.minister?.generalId === viewerId,
  };
  return { state, gov, index, general, nationId, roles };
}

export function governanceView(world: WorldView, viewerId: number | null, tick: number) {
  if (!world.ruleFeatures?.includes('governance-v1')) return { enabled: false as const };
  const { state, gov, index, nationId, roles } = viewerContext(world, viewerId, tick);
  const party = (first: number, second: number) => roles.monarch && (nationId === first || nationId === second);
  const rateReader = (first: number, second: number) =>
    party(first, second) ||
    roles.emperor ||
    (first === gov.throne.emperorNationId && (roles.chancellor || roles.minister));
  const offers = gov.offers.filter(
    (offer) =>
      offer.actorId === viewerId ||
      offer.sourceMonarchId === viewerId ||
      (offer.kind === 'COURT'
        ? offer.targetGeneralId === viewerId
        : roles.monarch && offer.targetNationId === nationId),
  );
  const year = state.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
  const courtCandidates = roles.emperor
    ? Object.values(state.generals)
        .filter(
          (general) =>
            general.id !== gov.throne.emperorGeneralId &&
            general.activeFromYear <= year &&
            general.nationId !== null &&
            index.alive.has(general.nationId) &&
            index.root(general.nationId).nationId === gov.throne.emperorNationId &&
            !GOVERNANCE_OFFICES.some((office) => gov.court[office]?.generalId === general.id),
        )
        .map((general) => general.id)
    : [];
  const names = new Set([
    viewerId,
    gov.throne.emperorGeneralId,
    ...GOVERNANCE_OFFICES.map((office) => gov.court[office]?.generalId),
    ...courtCandidates,
    ...offers.flatMap((offer) => [
      offer.actorId,
      offer.sourceMonarchId,
      ...(offer.kind === 'COURT' ? [offer.targetGeneralId] : []),
    ]),
  ]);
  const ascend =
    viewerId === null
      ? { ok: false as const, code: 'NO_GENERAL', message: '장수를 먼저 생성하세요.' }
      : decideGovernanceAction(state, viewerId, { type: 'throne.ascend' }, tick);
  return {
    enabled: true as const,
    viewerGeneralId: viewerId,
    nations: [...index.alive]
      .sort((a, b) => a - b)
      .map((id) => ({ id, name: state.nations[id]!.name, color: state.nations[id]!.color })),
    generals: Object.values(state.generals)
      .filter((general) => names.has(general.id))
      .sort((a, b) => a.id - b.id)
      .map(({ id, name, nationId, officerLevel }) => ({ id, name, nationId, officerLevel })),
    courtCandidates,
    monthlyTick: gov.monthlyTick,
    revision: gov.revision,
    throne: { ...gov.throne },
    seat: { cityKey: gov.config.seatCityKey, nationId: state.cities[gov.config.seatCityKey]!.nationId },
    legitimacy: Object.entries(gov.legitimacy)
      .map(([id, value]) => ({ nationId: Number(id), value }))
      .sort((a, b) => a.nationId - b.nationId),
    court: GOVERNANCE_OFFICES.map((office) => ({
      office,
      appointment: gov.court[office] ? { ...gov.court[office] } : null,
      stipendGold: gov.config.stipendGold[office],
    })),
    vassals: gov.vassals.map((row) => ({
      id: row.id,
      overlordNationId: row.overlordNationId,
      vassalNationId: row.vassalNationId,
      sinceTick: row.sinceTick,
      ...(rateReader(row.overlordNationId, row.vassalNationId)
        ? { goldBp: row.goldBp, riceBp: row.riceBp, remitUntilTick: row.remitUntilTick }
        : {}),
      ...(party(row.overlordNationId, row.vassalNationId)
        ? { renouncePending: gov.pendingRenounce.includes(row.id) }
        : {}),
    })),
    offers: offers.map((offer) => ({ ...offer })),
    roles,
    ownNationId: nationId,
    realmNationId: nationId !== null && index.alive.has(nationId) ? index.root(nationId).nationId : null,
    limits: {
      maxBp: gov.config.tribute.maxBp,
      offerMonths: gov.config.offerMonths,
      maxRemitMonths: gov.config.maxRemitMonths,
      maxDepth: gov.config.maxDepth,
      ascendAt: gov.config.legitimacy.ascendAt,
      censureLoss: gov.config.legitimacy.censureLoss,
      renounceLoss: gov.config.legitimacy.renounceLoss,
      censureCooldownMonths: gov.config.censureCooldownMonths,
    },
    ascend: ascend.ok
      ? { allowed: true as const }
      : { allowed: false as const, code: ascend.code, message: ascend.message },
  };
}

export function visibleGovernanceMovements<T extends GovernanceMovement>(
  world: WorldView,
  viewerId: number | null,
  tick: number,
  rows: readonly T[],
): T[] {
  if (!world.ruleFeatures?.includes('governance-v1')) return [];
  const { nationId, roles } = viewerContext(world, viewerId, tick);
  return rows
    .filter(
      (row) =>
        (roles.monarch && (row.fromNationId === nationId || (row.kind === 'TRIBUTE' && row.toNationId === nationId))) ||
        (row.kind === 'STIPEND' && row.holder === 'general' && row.holderId === viewerId && row.delta > 0),
    )
    .map((row) => ({ ...row }));
}

export function governanceLedgerScope(world: WorldView, viewerId: number | null, tick: number) {
  const { general, nationId, roles } = viewerContext(world, viewerId, tick);
  return { monarchNationId: roles.monarch ? nationId : null, generalId: general?.id ?? null };
}
