import type { GovernanceBoard, GovernanceView } from './governanceModel';

// 시험용 황실 조회 값. 1국(황제국) ← 2국 ← 3국 계열, 4·5국은 독립이다. 숫자는 시험 설정일 뿐이다.
export function testView(overrides: Partial<GovernanceView> = {}): GovernanceView {
  return {
    enabled: true,
    viewerGeneralId: 10,
    nations: [1, 2, 3, 4, 5].map((id) => ({ id, name: `국${id}`, color: '#336699' })),
    generals: [
      { id: 10, name: '황제', nationId: 1, officerLevel: 12, portraitId: null },
      { id: 20, name: '이군주', nationId: 2, officerLevel: 12, portraitId: null },
      { id: 30, name: '삼장수', nationId: 3, officerLevel: 5, portraitId: null },
    ],
    courtCandidates: [],
    monthlyTick: 0,
    revision: 1,
    throne: { emperorGeneralId: 10, emperorNationId: 1, sinceTick: 0 },
    seat: { cityKey: 7, nationId: 1 },
    legitimacy: [1, 2, 3, 4, 5].map((nationId) => ({ nationId, value: 50 })),
    court: [
      { office: 'chancellor', appointment: null, stipendGold: 77 },
      { office: 'grandMarshal', appointment: null, stipendGold: 77 },
      { office: 'minister', appointment: null, stipendGold: 77 },
    ],
    vassals: [
      { id: 1, overlordNationId: 1, vassalNationId: 2, sinceTick: 0 },
      { id: 2, overlordNationId: 2, vassalNationId: 3, sinceTick: 0 },
    ],
    offers: [],
    roles: { monarch: false, emperor: false, chancellor: false, grandMarshal: false, minister: false },
    ownNationId: 4,
    realmNationId: 4,
    limits: {
      maxBp: 1500,
      offerMonths: 4,
      maxRemitMonths: 9,
      maxDepth: 3,
      ascendAt: 55,
      censureLoss: 6,
      renounceLoss: 8,
      censureCooldownMonths: 5,
    },
    ascend: { allowed: false, code: 'NO_AUTHORITY', message: '군주만 즉위할 수 있습니다.' },
    ...overrides,
  } satisfies GovernanceView;
}

export function testBoard(userId: string, worldId: string, view: GovernanceView = testView()): GovernanceBoard {
  return {
    userId,
    worldId,
    status: 'RUNNING',
    tick: 0,
    settling: false,
    canSubmit: true,
    view,
    movements: [],
  } satisfies GovernanceBoard;
}
