import { describe, expect, it } from 'vitest';
import type { NationView } from '../game/types';
import { appointCandidates, matchesCandidate, memberDetails, nameLabels, statTotal } from './candidates';
import type { PersonnelBoard, PersonnelMember } from './contract';

const member = (generalId: number, name: string, officerLevel: number, title: string): PersonnelMember => ({
  generalId,
  name,
  officerLevel,
  title,
  isHuman: false,
  city: { cityKey: generalId, name: `도시${generalId}` },
  dedication: 0,
});

describe('인사부 임명 후보 (INT-25 단계 3)', () => {
  it('nation.get 장수를 id로 잇고 공개 범위 밖 장수는 뺀다. 부곡 월드는 지휘 병력을 쓴다', () => {
    const own = {
      id: 3,
      name: '조운',
      nationId: 1,
      portraitId: 77,
      cityKey: 2,
      leadership: 90,
      strength: 96,
      intel: 76,
      officerLevel: 1,
      personality: '의리',
      special: null,
      crew: 500,
      injury: 0,
      commandedArmy: { troops: 4200, train: 80, atmos: 80 },
    };
    const hidden = { id: 9, name: '첩자', nationId: 2 };
    const details = memberDetails([own, hidden] as unknown as NationView['generals']);
    expect([...details.keys()]).toEqual([3]);
    expect(details.get(3)).toMatchObject({ portraitId: 77, troops: 4200, personality: '의리', special: null });
    expect(statTotal(details.get(3))).toBe(262);
    expect(statTotal(undefined)).toBeNull();
  });

  it('이름은 괄호를 빼되 같은 화면에서 겹치면 괄호를 둔다', () => {
    const labels = nameLabels([
      member(1, '조조(曹操)', 12, '군주'),
      member(2, '유도(145년생)', 1, '장수'),
      member(3, '유도(160년생)', 1, '장수'),
    ]);
    expect([...labels.values()]).toEqual(['조조', '유도(145년생)', '유도(160년생)']);
  });

  it('군주를 빼고 직책 없는 장수를 능력치 합 순으로 먼저, 다른 관직 장수를 뒤에 둔다', () => {
    const board: PersonnelBoard = {
      actorId: 1,
      appoint: { ok: true },
      levels: [
        { officerLevel: 11, title: '참모', holderId: 2 },
        { officerLevel: 10, title: '수뇌', holderId: null },
      ],
      members: [
        member(1, '유비', 12, '군주'),
        member(2, '제갈량', 11, '참모'),
        member(3, '간옹', 1, '장수'),
        member(4, '조운', 1, '장수'),
        member(5, '미축', 0, '재야'),
      ],
    };
    const stats = (l: number, s: number, i: number) => ({
      portraitId: null,
      leadership: l,
      strength: s,
      intel: i,
      personality: null,
      special: '귀병',
      troops: 0,
      injury: 0,
    });
    const details = new Map([
      [2, stats(70, 30, 100)],
      [3, stats(40, 30, 70)],
      [4, stats(90, 96, 76)],
    ]);
    const list = appointCandidates(board, details);
    expect(list.map((c) => [c.member.generalId, c.state.kind])).toEqual([
      [4, 'free'],
      [3, 'free'],
      [5, 'free'],
      [2, 'office'],
    ]);
    expect(list.find((c) => c.member.generalId === 2)?.state).toEqual({ kind: 'office', title: '참모' });
    expect(list.filter((c) => matchesCandidate(c, '도시3')).map((c) => c.member.generalId)).toEqual([3]);
    expect(list.filter((c) => matchesCandidate(c, '귀병')).map((c) => c.member.generalId)).toEqual([4, 3, 2]);
    expect(list.filter((c) => matchesCandidate(c, '  ')).length).toBe(4);
  });
});
