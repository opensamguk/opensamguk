import type { CreateDraft, CreateOptions, CreateProfile } from '../adminCreateModel';
export const viewerId = '11111111-1111-4111-8111-111111111111';
export const requestKey = '22222222-2222-4222-8222-222222222222';
export const requestId = '33333333-3333-4333-8333-333333333333';
export const worldId = '44444444-4444-4444-8444-444444444444';
export const options: CreateOptions = {
  userId: viewerId,
  revision: 'reviewed',
  profiles: [
    {
      id: 'integration-v01',
      label: '통합판 v0.1 · 191년 군웅할거',
      available: true,
      selection: {
        scenarioKey: 'integration191',
        mapKey: 'integration',
        unitSetKey: 'basic',
        statRulesKey: 'five-stats',
        portraitMapKey: '191-map',
      },
      scenarioTitle: '191년 군웅할거',
      mapName: '통합판 삼국 지도',
      startYear: 191,
      counts: { nations: 21, generals: 491, cities: 53, gates: 8, ports: 6, fields: 13, anchors: 61 },
      resources: [],
      ruleFeatures: [
        'battle-affinity-v2',
        'campaign-assignment-v2',
        'campaign-v1',
        'city-resources-v1',
        'five-stats',
        'operational-map',
        'personnel',
        'policy',
        'stratagem-basic',
        'treaty',
      ],
      presets: [
        {
          key: 'regular',
          label: '정규',
          contentHash: 'preset-hash',
          turnTermMinutes: 60,
          descriptions: ['건국 보호0개월'],
        },
      ],
      suggestedEndYear: 201,
    },
  ],
};
export const draft: CreateDraft = {
  profileId: 'integration-v01',
  resources: {},
  name: ' 새 월드 ',
  presetKey: 'regular',
  turnTerm: '60',
  endMode: 'year',
  endYear: '201',
  seedMode: 'auto',
  seed: '',
};

const baseProfile = options.profiles.find((profile): profile is CreateProfile => profile.available)!;
export const expandedProfile: CreateProfile = {
  ...baseProfile,
  id: 'integration-v01-expanded',
  label: '통합판 확장 · 191년 군웅할거',
  featureProfileKey: 'expanded-191-v3',
  featureProfileHash: 'a'.repeat(64),
  ruleFeatures: [
    ...baseProfile.ruleFeatures,
    'equipment-v1',
    'governance-v1',
    'heritage-v1',
    'lineage-v1',
    'logistics-v1',
  ].sort(),
  suggestedEndYear: 231,
};
