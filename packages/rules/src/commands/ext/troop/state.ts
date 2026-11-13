import { z } from 'zod';
import type { DeepReadonly, JsonValue, WorldState, WorldView } from '../../../model/world';
import type { ExtSlice } from '../state';

export const TROOP_FEATURE = 'troop-v1';
export const gatherBinding = { commandKey: 'troop_gather', target: 'general', sliceKeys: ['troop'] } as const;

function isWide(point: number) {
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    point === 0x2329 ||
    point === 0x232a ||
    (point >= 0x2e80 && point <= 0x3247 && point !== 0x303f) ||
    (point >= 0x3250 && point <= 0x4dbf) ||
    (point >= 0x4e00 && point <= 0xa4c6) ||
    (point >= 0xa960 && point <= 0xa97c) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) ||
    (point >= 0xfe30 && point <= 0xfe6b) ||
    (point >= 0xff01 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1b000 && point <= 0x1b001) ||
    (point >= 0x1f200 && point <= 0x1f251) ||
    (point >= 0x20000 && point <= 0x3fffd)
  );
}

export function troopName(input: string) {
  const name = input.normalize('NFC').replace(/^[\p{Z}\p{C}]+|[\p{Z}\p{C}]+$/gu, '');
  if (/\p{C}/u.test(name)) return null;
  const width = Array.from(name).reduce((sum, char) => sum + (isWide(char.codePointAt(0)!) ? 2 : 1), 0);
  return width > 0 && width <= 18 ? name : null;
}

const id = z.number().int().positive();
const record = z.strictObject({
  leaderId: id,
  nationId: id,
  name: z.string().refine((name) => troopName(name) === name),
  members: z.array(id),
});
function troopSchema() {
  return z.strictObject({ troops: z.record(z.string(), record) }).refine(({ troops }) => {
    const assigned = new Set<number>();
    for (const [key, row] of Object.entries(troops)) {
      if (key !== String(row.leaderId) || assigned.has(row.leaderId)) return false;
      assigned.add(row.leaderId);
      let previous = 0;
      for (const memberId of row.members) {
        if (memberId <= previous || assigned.has(memberId)) return false;
        assigned.add(memberId);
        previous = memberId;
      }
    }
    return true;
  });
}
export type TroopSlice = z.infer<ReturnType<typeof troopSchema>>;
export const troopSlice = {
  key: 'troop',
  create: () => ({ troops: {} }),
  clone: (value: DeepReadonly<JsonValue>): TroopSlice => troopSchema().parse(value),
  validate: (value: unknown): value is TroopSlice => troopSchema().safeParse(value).success,
} satisfies ExtSlice;

export function reconcileTroops(view: WorldView, source: DeepReadonly<TroopSlice>): TroopSlice {
  const belongs = (generalId: number, nationId: number) => {
    const general = view.generals[generalId];
    return general?.nationId === nationId && general.removedAt === undefined;
  };
  const troops: TroopSlice['troops'] = {};
  for (const row of Object.values(source.troops)) {
    if (!view.nations[row.nationId] || !belongs(row.leaderId, row.nationId)) continue;
    troops[row.leaderId] = { ...row, members: row.members.filter((id) => belongs(id, row.nationId)) };
  }
  return { troops };
}

export function readTroops(view: WorldView) {
  if (!view.ruleFeatures?.includes(TROOP_FEATURE)) return undefined;
  const parsed = troopSchema().parse(view.ext?.troop);
  return reconcileTroops(view, parsed);
}

export function cleanTroops(state: WorldState) {
  const troops = readTroops(state);
  if (troops) state.ext!.troop = troops;
}
