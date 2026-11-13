import type { PresetRules } from '../world/preset';
import { cloneExtStateWithRegistry, extRegistryForRuleFeatures, type ExtStateRegistry } from '../commands/ext/state';
import type { WorldState, WorldView } from './world';

// 모든 가변 필드를 복제한다. 평평한 장수 수백 명을 매 턴 직렬화하지 않는다.
export function cloneWorld(view: WorldView): WorldState {
  return cloneWorldWithRegistry(view, extRegistryForRuleFeatures(view.ruleFeatures));
}

export function cloneWorldWithRegistry(view: WorldView, registry: ExtStateRegistry): WorldState {
  const ext = Object.hasOwn(view, 'ext') ? cloneExtStateWithRegistry(view.ext, registry) : undefined;
  const cities: WorldState['cities'] = {};
  const nations: WorldState['nations'] = {};
  const generals: WorldState['generals'] = {};
  for (const key in view.cities) {
    const { conflictOrder, ...city } = view.cities[key]!;
    cities[key] = {
      ...city,
      connections: [...city.connections],
      ...(conflictOrder ? { conflictOrder: [...conflictOrder] } : {}),
    };
  }
  for (const key in view.nations) {
    const { npcSettings, ...nation } = view.nations[key]!;
    nations[key] = nation;
    if (npcSettings) {
      const { generalPriority, nationPriority, ...settings } = npcSettings;
      nations[key]!.npcSettings = {
        ...settings,
        ...(generalPriority ? { generalPriority: [...generalPriority] } : {}),
        ...(nationPriority ? { nationPriority: [...nationPriority] } : {}),
      };
    }
  }
  for (const key in view.generals) generals[key] = { ...view.generals[key]! };
  return {
    ...(view.relations ? { relations: structuredClone(view.relations) as NonNullable<WorldState['relations']> } : {}),
    ...(view.cityOfficeVolunteers
      ? {
          cityOfficeVolunteers: structuredClone(view.cityOfficeVolunteers) as NonNullable<
            WorldState['cityOfficeVolunteers']
          >,
        }
      : {}),
    ...(view.officeEffects ? { officeEffects: structuredClone(view.officeEffects) } : {}),
    ...(view.preparedTurns
      ? { preparedTurns: structuredClone(view.preparedTurns) as NonNullable<WorldState['preparedTurns']> }
      : {}),
    ...(view.nationResearch
      ? { nationResearch: structuredClone(view.nationResearch) as NonNullable<WorldState['nationResearch']> }
      : {}),
    ...(view.nationLifecycle
      ? { nationLifecycle: structuredClone(view.nationLifecycle) as NonNullable<WorldState['nationLifecycle']> }
      : {}),
    ...(view.nationStrategy
      ? { nationStrategy: structuredClone(view.nationStrategy) as NonNullable<WorldState['nationStrategy']> }
      : {}),
    ...(view.cityRuins ? { cityRuins: structuredClone(view.cityRuins) as NonNullable<WorldState['cityRuins']> } : {}),
    ...(view.equipment ? { equipment: structuredClone(view.equipment) as NonNullable<WorldState['equipment']> } : {}),
    ...(view.stratagemCards
      ? { stratagemCards: structuredClone(view.stratagemCards) as NonNullable<WorldState['stratagemCards']> }
      : {}),
    ...(view.lineage ? { lineage: structuredClone(view.lineage) as NonNullable<WorldState['lineage']> } : {}),
    ...(view.governance
      ? { governance: structuredClone(view.governance) as NonNullable<WorldState['governance']> }
      : {}),
    ...(view.logistics ? { logistics: structuredClone(view.logistics) as NonNullable<WorldState['logistics']> } : {}),
    ...(view.cityResources
      ? { cityResources: structuredClone(view.cityResources) as NonNullable<WorldState['cityResources']> }
      : {}),
    ...(view.campaign ? { campaign: structuredClone(view.campaign) as NonNullable<WorldState['campaign']> } : {}),
    ...(ext ? { ext } : {}),
    ...(view.presetRules ? { presetRules: structuredClone(view.presetRules) as PresetRules } : {}),
    ...(view.recruitmentLocation ? { recruitmentLocation: view.recruitmentLocation } : {}),
    ...(view.ruleFeatures ? { ruleFeatures: [...view.ruleFeatures] } : {}),
    startYear: view.startYear,
    cities,
    nations,
    generals,
    diplomacies: view.diplomacies.map((d) => ({ ...d })),
    ...(view.treaties?.length
      ? {
          treaties: view.treaties.map((treaty) => ({
            ...treaty,
            clauses: treaty.clauses.map((clause) =>
              clause.kind === 'passage' ? { ...clause, cityKeys: [...clause.cityKeys] } : { ...clause },
            ),
          })),
        }
      : {}),
    ...(view.nationTrust?.length ? { nationTrust: view.nationTrust.map((entry) => ({ ...entry })) } : {}),
    ...(view.commandMeta
      ? {
          commandMeta: {
            nextNationId: view.commandMeta.nextNationId,
            offers: { ...view.commandMeta.offers },
            ...(view.commandMeta.lastNationRecruitmentLock
              ? { lastNationRecruitmentLock: { ...view.commandMeta.lastNationRecruitmentLock } }
              : {}),
          },
        }
      : {}),
    ...(view.nationTurns
      ? { nationTurns: structuredClone(view.nationTurns) as NonNullable<WorldState['nationTurns']> }
      : {}),
    ...(view.assignmentOffers && Object.keys(view.assignmentOffers).length
      ? {
          assignmentOffers: Object.fromEntries(
            Object.entries(view.assignmentOffers).map(([id, offer]) => [id, { ...offer }]),
          ),
        }
      : {}),
    ...(view.officeTurns && Object.keys(view.officeTurns).length
      ? { officeTurns: structuredClone(view.officeTurns) as NonNullable<WorldState['officeTurns']> }
      : {}),
  };
}
