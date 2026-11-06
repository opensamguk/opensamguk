import { z } from 'zod';
import type { WorldView, JsonValue } from '../model/world';
import type { CommandResolver } from '../commands/resolve';
import type { UnitSetResource } from '../world/resources';
import { generalTurnCandidates } from '../npc';
import { lineageActive } from '../lineage/eligibility';
import { recommendNations } from '../entry/roles';

export const noticeDirectiveSchema = z.strictObject({
  commandKey: z.string().min(1).max(64),
  args: z.record(z.string(), z.json()),
});
export type NoticeDirective = z.infer<typeof noticeDirectiveSchema>;
type SuggestedTurn = { commandKey: string; args: unknown; reason: string };
export interface AdviceOperation extends SuggestedTurn {
  id: string;
  targetTick: number;
}
export interface AdviceItem {
  source: 'operation' | 'notice' | 'ai';
  commandKey: string;
  commandName: string;
  args: Record<string, JsonValue>;
  argsLabel: string;
  reason: string;
  score: number | null;
  nation: { id: number; name: string; color: string } | null;
}
export interface AdviceSkipped {
  source: 'operation' | 'notice';
  commandKey: string;
  code: string;
  message: string;
}
export interface AdviceContext {
  tick: number;
  unitSet: UnitSetResource;
  resolver: CommandResolver;
  operations?: readonly AdviceOperation[];
  directive?: SuggestedTurn | undefined;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function jsonKey(value: JsonValue): string {
  if (Array.isArray(value)) return '[' + value.map(jsonKey).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + jsonKey(value[key]!))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const labels: Record<string, string> = {
  amount: '수량',
  unitId: '부곡',
  resource: '자원',
  target: '대상',
  generalId: '장수',
  itemId: '장비',
  policy: '방침',
};
const values: Record<string, string> = {
  gold: '금',
  rice: '쌀',
  iron: '철',
  wood: '목재',
  horses: '말',
  city: '도시 수비병',
};
function describe(args: Record<string, JsonValue>, view: WorldView, unitSet: UnitSetResource) {
  return Object.keys(args)
    .sort()
    .map((key) => {
      const value = args[key]!;
      if (key === 'cityKey' && typeof value === 'number') return view.cities[value]?.name ?? '도시';
      if (key === 'nationId' && typeof value === 'number') return view.nations[value]?.name ?? '국가';
      if (key === 'generalId' && typeof value === 'number') return view.generals[value]?.name ?? '장수';
      if (key === 'crewType' && typeof value === 'number')
        return unitSet.crewTypes.find((row) => row.id === value)?.name ?? '병종';
      if (key === 'buy' && typeof value === 'boolean') return value ? '쌀 사기' : '쌀 팔기';
      const text =
        typeof value === 'string'
          ? (values[value] ?? value)
          : typeof value === 'number'
            ? String(value)
            : typeof value === 'boolean'
              ? value
                ? '예'
                : '아니오'
              : '설정한 값';
      return (labels[key] ?? '선택값') + ' ' + text;
    })
    .join(' · ');
}

export function adviseGeneral(view: WorldView, generalId: number, context: AdviceContext) {
  const items: AdviceItem[] = [],
    skipped: AdviceSkipped[] = [],
    seen = new Set<string>();
  const general = view.generals[generalId];
  if (!general || !lineageActive(view, generalId, context.tick)) return { items, skipped };
  const actor = { generalId, tick: context.tick, unitSet: context.unitSet };
  function append(
    source: AdviceItem['source'],
    candidate: SuggestedTurn,
    score: number | null,
    nation: AdviceItem['nation'] = null,
  ) {
    const definition = context.resolver.get(candidate.commandKey);
    const parsed = definition?.target === 'general' ? definition.args.safeParse(candidate.args) : undefined;
    const json = parsed?.success ? z.record(z.string(), z.json()).safeParse(parsed.data) : undefined;
    const failure = !definition
      ? { code: 'COMMAND_DISABLED', message: '이 월드에서 꺼진 명령입니다.' }
      : !json?.success
        ? { code: 'BAD_ARGS', message: '명령의 선택값을 확인하세요.' }
        : context.resolver.precheck(view, actor, candidate.commandKey, json.data);
    if (failure || !definition || !json?.success) {
      if (source !== 'ai')
        skipped.push({
          source,
          commandKey: candidate.commandKey,
          ...(failure ?? { code: 'BAD_ARGS', message: '명령의 선택값을 확인하세요.' }),
        });
      return;
    }
    const args = json.data;
    const key = candidate.commandKey + ':' + jsonKey(args);
    if (seen.has(key) || items.length === 3) return;
    seen.add(key);
    items.push({
      source,
      commandKey: definition.key,
      commandName: definition.name,
      args,
      argsLabel: describe(args, view, context.unitSet),
      reason: candidate.reason,
      score,
      nation,
    });
  }
  if (general.nationId === null) {
    for (const nation of recommendNations(view, generalId, context.tick))
      append('ai', { commandKey: 'join', args: { nationId: nation.id }, reason: nation.reason }, null, {
        id: nation.id,
        name: nation.name,
        color: nation.color,
      });
    return { items, skipped };
  }
  for (const operation of [...(context.operations ?? [])].sort(
    (a, b) => a.targetTick - b.targetTick || compareText(a.id, b.id),
  ))
    append('operation', operation, null);
  if (context.directive) append('notice', context.directive, null);
  const candidates = generalTurnCandidates(view, general, context).map((candidate) => ({
    ...candidate,
    args: z.record(z.string(), z.json()).parse(candidate.args),
  }));
  candidates.sort(
    (a, b) => b.score - a.score || compareText(a.key, b.key) || compareText(jsonKey(a.args), jsonKey(b.args)),
  );
  for (const candidate of candidates)
    append('ai', { commandKey: candidate.key, args: candidate.args, reason: candidate.reason }, candidate.score);
  return { items, skipped };
}
