import type { WorldView } from '../model/world';

export type LineagePublicEvent = { commandKey: string; text: string; generalIds: number[]; nationIds: number[] };

// 공개 가계의 변화만 기록한다. 혼인 제안·후계 지정·지갑은 포함하지 않는다.
export function lineagePublicEvents(before: WorldView, next: WorldView): LineagePublicEvent[] {
  if (!before.lineage && !next.lineage) return [];
  if (!before.lineage || !next.lineage) throw Error('가문 기록의 기능이 바뀌었습니다.');
  const events: LineagePublicEvent[] = [];
  const add = (commandKey: string, text: string, ids: number[]) => {
    const generalIds = [...new Set(ids)].sort((a, b) => a - b);
    const nationIds = [
      ...new Set(
        generalIds.flatMap((id) => {
          const nationId = next.generals[id]?.nationId ?? before.generals[id]?.nationId;
          return nationId === null || nationId === undefined ? [] : [nationId];
        }),
      ),
    ].sort((a, b) => a - b);
    events.push({ commandKey, text, generalIds, nationIds });
  };
  for (const general of Object.values(next.generals).sort((a, b) => a.id - b.id)) {
    const person = next.lineage.persons[String(general.id)];
    if (!before.generals[general.id]) {
      if (!person || person.parents.length !== 2) throw Error('출생 기록의 부모가 없습니다.');
      const names = person.parents.map((id) => next.generals[id]!.name).join('·');
      add('lineage.birth', `${names}의 자녀 ${general.name} 출생`, [...person.parents, general.id]);
    }
    if (person?.exit && !before.lineage.persons[String(general.id)]?.exit) {
      if (person.successorId !== null) {
        const heir = next.generals[person.successorId]!;
        add(
          'lineage.succession',
          `${general.name} ${person.exit.cause === 'DIED' ? '사망' : '은퇴'} · ${heir.name} 계승`,
          [general.id, heir.id],
        );
      } else add('lineage.death', `${general.name} 사망 · 후계자 없이 개인 재산과 소유 부대 정리`, [general.id]);
    }
    if (general.officerLevel === 12 && before.generals[general.id]?.officerLevel !== 12) {
      const nation = general.nationId === null ? undefined : next.nations[general.nationId];
      if (nation) add('lineage.ruler.claim', `${general.name} ${nation.name} 군주 취임`, [general.id]);
    }
  }
  const existing = new Set(before.lineage.marriages.map((row) => row.id));
  for (const marriage of next.lineage.marriages.filter((row) => !existing.has(row.id)).sort((a, b) => a.id - b.id)) {
    const a = next.generals[marriage.a]!,
      b = next.generals[marriage.b]!;
    add('lineage.marriage', `${a.name}·${b.name} 혼인`, [a.id, b.id]);
  }
  return events;
}
