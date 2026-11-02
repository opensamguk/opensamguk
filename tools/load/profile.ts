import type { WorldInit } from '../../packages/rules/src/index';
import type { InitialResources } from '../../apps/engine/src/world/resources';
import { hashState } from '../../packages/shared/src/node/hashState';
import { LOAD_CONTRACT, LOAD_RESOURCES } from './contract';

export function assertLoadProfile(initial: WorldInit) {
  const sites = initial.operationalMap?.sites;
  if (
    initial.scenarioKey !== LOAD_RESOURCES.scenario ||
    initial.mapKey !== LOAD_RESOURCES.map ||
    initial.unitSetKey !== LOAD_RESOURCES.unitSet ||
    initial.startYear !== 191 ||
    initial.statRules.count !== 5 ||
    initial.generals.length !== LOAD_CONTRACT.historicalGenerals ||
    new Set(initial.generals.map((general) => general.id)).size !== LOAD_CONTRACT.historicalGenerals ||
    initial.nations.length !== 21 ||
    initial.cities.length !== 61 ||
    sites?.filter((site) => site.kind === 'CITY').length !== 53 ||
    sites.filter((site) => site.kind === 'PASS').length !== 8 ||
    sites.filter((site) => site.kind === 'PORT').length !== 6 ||
    sites.filter((site) => site.kind === 'FIELD').length !== 13
  )
    throw new Error('LOAD_FORMAL_PROFILE_REQUIRED');
  return {
    scenario: initial.scenarioKey,
    map: initial.mapKey,
    startYear: initial.startYear,
    historicalGeneralIds: initial.generals.map((general) => general.id).sort((a, b) => a - b),
    nations: initial.nations.length,
    cities: 53,
    passes: 8,
    ports: 6,
    fields: 13,
  };
}

export function loadResourceManifest(resources: InitialResources) {
  return Object.entries(resources).map(([slot, resource]) => ({
    slot,
    kind: resource.kind,
    name: resource.name,
    version: resource.version,
    source: resource.source,
    contentSha256: hashState(resource.content),
  }));
}
