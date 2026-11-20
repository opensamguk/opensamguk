// 성 안 창에서 국가 명령 증축, 감축을 국가 예턴에 넣는다(INT-30, D-109).
// 같은 명령과 도시를 연속 다섯 칸에 넣어야 실행된다(준비 턴, U-01). 내 직책 탭에서 처음 나오는 연속 빈 칸 다섯을 쓴다.
import type { DisplaySlot } from '../turns/source';
import type { NationTurnTab, PersonnelApi } from '../personnel/contract';
import type { ReserveResult } from './LotWindow';

export type ScaleCommand = 'nation_expand' | 'nation_shrink';
export const SCALE_TURNS = 5;
const EMPTY = 'nation_rest';

type SaveSlot = { commandKey: string; args: Record<string, unknown> } | null;

/** 12칸에서 처음 나오는 연속 빈 칸 다섯에 명령을 넣은 저장용 칸 목록과 시작 칸. 자리가 없으면 null. */
export function planScaleSlots(
  slots: readonly DisplaySlot[],
  command: ScaleCommand,
  cityKey: number,
): { from: number; slots: SaveSlot[] } | null {
  for (let from = 0; from + SCALE_TURNS <= slots.length; from++) {
    if (!slots.slice(from, from + SCALE_TURNS).every((slot) => slot.commandKey === EMPTY)) continue;
    return {
      from,
      slots: slots.map((slot, n) =>
        n >= from && n < from + SCALE_TURNS
          ? { commandKey: command, args: { cityKey } }
          : slot.commandKey === EMPTY
            ? null
            : { commandKey: slot.commandKey, args: (slot.args ?? {}) as Record<string, unknown> },
      ),
    };
  }
  return null;
}

/** 내가 편집할 수 있는 직책 탭(여럿이면 높은 직책). */
export function editableTab(tabs: readonly NationTurnTab[]): NationTurnTab | null {
  return [...tabs].filter((tab) => tab.edit.ok).sort((a, b) => b.officerLevel - a.officerLevel)[0] ?? null;
}

export async function reserveScale(
  api: Pick<PersonnelApi, 'nationTurns' | 'setNationTurns'>,
  worldId: string,
  command: ScaleCommand,
  cityKey: number,
): Promise<ReserveResult> {
  const data = await api.nationTurns({ worldId });
  const tab = editableTab(data.tabs);
  if (!tab) return { ok: false, message: '국가 예턴을 고칠 수 있는 직책이 없습니다.' };
  const plan = planScaleSlots(tab.slots, command, cityKey);
  if (!plan) return { ok: false, message: `국가 예턴에 연속 빈 칸 ${SCALE_TURNS}개가 없습니다.` };
  const saved = await api.setNationTurns({
    worldId,
    office: tab.office,
    revision: tab.revision,
    expectedActorId: data.actorId,
    slots: plan.slots,
  });
  if (!saved.ok) return { ok: false, message: '그 사이 국가 예턴이 바뀌었습니다. 다시 눌러 주세요.' };
  return { ok: true, slot: plan.from };
}
