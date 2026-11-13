import type { Actor, CommandDef, WorldView } from '@opensamguk/rules';

export function commandAvailability(def: CommandDef, view: WorldView | null, actor: Actor | null, ended: boolean) {
  if (ended) return { available: false, reason: '종료된 월드입니다.' };
  if (!view || !actor) return { available: false, reason: '이 월드에 내 장수가 없습니다.' };
  const args = def.args.safeParse({});
  if (!args.success) return { available: null, reason: '대상이나 값을 고르면 실행 가능 여부를 확인합니다.' };
  const failure = def.precheck(view, actor, args.data);
  return { available: failure === null, reason: failure?.message ?? null };
}
