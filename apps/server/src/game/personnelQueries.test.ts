import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import {
  APPOINTABLE_OFFICER_LEVELS,
  officerTitle,
  canManagePersonnel,
  canUseNationTurns,
  canExecuteNationCommand,
  nationCommandKeys,
  isAppointableOfficerLevel,
  validateTreatyState,
  treatyRespondByTick,
} from '@opensamguk/rules';
import { readPersonnelBoard } from './personnelQueries';

type General = Prisma.GeneralGetPayload<Record<string, never>>;
function general(changes: Partial<General> = {}): General {
  return {
    worldId: 'world',
    id: 1,
    userId: 'own',
    nationId: 1,
    cityKey: 1,
    officerLevel: 12,
    name: '장수',
    affinity: 0,
    portraitId: null,
    leadership: 50,
    strength: 50,
    intel: 50,
    birthYear: 160,
    deathYear: 220,
    activeFromYear: 180,
    personality: null,
    special: null,
    gold: 0,
    rice: 0,
    crew: 0,
    crewType: 0,
    train: 0,
    atmos: 0,
    experience: 0,
    dedication: 10,
    battleWins: 0,
    captures: 0,
    age: 31,
    injury: 0,
    nextTurnTick: 0,
    turnRevision: 0,
    defaultPolicy: null,
    lastActiveTick: null,
    lastActiveAt: null,
    noticeSeen: null,
    ...changes,
  };
}
const clients: ReturnType<typeof createDb>[] = [];
function fixture(actor = general()) {
  const db = createDb('postgresql://unused@127.0.0.1:1/unused');
  clients.push(db);
  const findUnique = vi.spyOn(db.general, 'findUnique').mockResolvedValue(actor);
  const rows = [
    { ...general(), city: { cityKey: 1, name: '낙양' } },
    { ...general({ id: 3, userId: null, officerLevel: 5 }), city: { cityKey: 2, name: '장안' } },
    { ...general({ id: 4, userId: 'member', officerLevel: 1 }), city: { cityKey: 1, name: '낙양' } },
  ];
  const findMany = vi.spyOn(db.general, 'findMany').mockResolvedValue(rows);
  return { db, actor, rows, findUnique, findMany };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((db) => db.$disconnect()));
});

describe('인사부 내부 읽기', () => {
  it('군주를 구성원에 포함하되 임명 행은 11~5이고 빈 직책은 null이다', async () => {
    const { db, rows, findMany } = fixture();
    const result = await readPersonnelBoard(db, { worldId: 'world', userId: 'own' });
    expect(result.appoint).toEqual({ ok: true });
    expect(result.levels.map((level) => level.officerLevel)).toEqual([11, 10, 9, 8, 7, 6, 5]);
    expect(result.levels.at(-1)).toEqual({ officerLevel: 5, title: '수뇌', holderId: 3 });
    expect(result.levels[0]).toEqual({ officerLevel: 11, title: '참모', holderId: null });
    expect(result.members.map((member) => member.officerLevel)).toEqual([12, 5, 1]);
    expect(result.members[1]).toEqual({
      generalId: 3,
      name: '장수',
      officerLevel: 5,
      title: '수뇌',
      isHuman: false,
      city: { cityKey: 2, name: '장안' },
      dedication: 10,
    });
    expect(result.members[0]).not.toHaveProperty('userId');
    expect(result.members[0]).not.toHaveProperty('gold');
    expect(rows[0]!.userId).toBe('own');
    expect(findMany).toHaveBeenCalledWith({
      where: { worldId: 'world', nationId: 1 },
      orderBy: [{ officerLevel: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        officerLevel: true,
        userId: true,
        dedication: true,
        city: { select: { cityKey: true, name: true } },
      },
    });
  });
  it.each([0, 1, 5, 10, 11, 12])('현재 행위자 직책 %i로만 인사 권한을 계산한다', async (officerLevel) => {
    const { db } = fixture(general({ officerLevel }));
    const input = { worldId: 'world', userId: 'own', generalId: 999, nationId: 999, officerLevel: 12 };
    expect((await readPersonnelBoard(db, input)).appoint).toEqual(
      officerLevel === 12 ? { ok: true } : { ok: false, reason: '군주만 임명·해임할 수 있습니다.' },
    );
  });
  it('다른 사용자는 그 세션 장수를 조회하고 그 장수의 현재 국가로 제한한다', async () => {
    const { db, findUnique, findMany } = fixture(general({ userId: 'other', nationId: 2, officerLevel: 1 }));
    findMany.mockResolvedValue([]);
    const board = await readPersonnelBoard(db, { worldId: 'world', userId: 'other' });
    expect(findUnique).toHaveBeenCalledWith({ where: { worldId_userId: { worldId: 'world', userId: 'other' } } });
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ worldId: 'world', nationId: 2 });
    expect(board.appoint.ok).toBe(false);
    expect(board.members).toEqual([]);
  });
  it('같은 사용자라도 다른 월드의 장수를 권한으로 쓰지 않는다', async () => {
    const { db, findUnique, findMany } = fixture();
    findUnique.mockResolvedValue(null);
    await expect(readPersonnelBoard(db, { worldId: 'other-world', userId: 'own' })).rejects.toHaveProperty(
      'code',
      'NOT_FOUND',
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { worldId_userId: { worldId: 'other-world', userId: 'own' } } });
    expect(findMany).not.toHaveBeenCalled();
  });
  it('재야는 목록을 읽지 않는다', async () => {
    const { db, findMany } = fixture(general({ nationId: null, officerLevel: 0 }));
    await expect(readPersonnelBoard(db, { worldId: 'world', userId: 'own' })).rejects.toHaveProperty(
      'code',
      'FORBIDDEN',
    );
    expect(findMany).not.toHaveBeenCalled();
  });
  it('정의되지 않은 직책과 중복 직책자를 조용히 표시하지 않는다', async () => {
    const { db, rows, findMany } = fixture();
    findMany.mockResolvedValue([{ ...rows[0]!, officerLevel: 2 }]);
    await expect(readPersonnelBoard(db, { worldId: 'world', userId: 'own' })).rejects.toHaveProperty(
      'code',
      'INTERNAL_SERVER_ERROR',
    );
    findMany.mockResolvedValue([
      { ...rows[0]!, officerLevel: 11 },
      { ...rows[1]!, officerLevel: 11 },
    ]);
    await expect(readPersonnelBoard(db, { worldId: 'world', userId: 'own' })).rejects.toHaveProperty(
      'code',
      'INTERNAL_SERVER_ERROR',
    );
  });
});

describe('기존 권한 함수의 루트 공개', () => {
  it('일곱 이름을 실제 권한 표에서 내보내며 조약 공개도 보존한다', () => {
    expect(officerTitle(12)).toBe('군주');
    expect(canManagePersonnel(11)).toBe(false);
    expect(canUseNationTurns(5)).toBe(true);
    expect(canExecuteNationCommand(11, 'nation_pact')).toBe(true);
    expect(canExecuteNationCommand(5, 'nation_pact')).toBe(false);
    expect(nationCommandKeys(5)).toContain('nation_assign');
    expect(APPOINTABLE_OFFICER_LEVELS).not.toContain(12);
    expect(isAppointableOfficerLevel(12)).toBe(false);
    expect(typeof validateTreatyState).toBe('function');
    expect(typeof treatyRespondByTick).toBe('function');
  });
});
