import type { Rng } from '@opensamguk/shared';
import { applyEffects } from '../commands/effects';
import type { CommandResolver } from '../commands/resolve';
import { fail, success } from '../commands/support';
import type { Actor, CommandDef, CommandResult } from '../commands/types';
import type { WorldView } from '../model/world';
import { cloneWorld } from '../model/clone';
import { campaignAttack } from './attack';
import { followCampaignCommanders } from './movement';
import {
  applyCampaignPreparation,
  campaignDrillArgs,
  campaignRecruitArgs,
  type CampaignPreparationKey,
} from './preparation';
import { readCampaignState } from './state';
import { hasCampaignOrderAuthority } from './orders';

const preparation = ['recruit', 'conscript', 'train', 'morale', 'dismiss'] as const;
const military = new Set<string>([...preparation, 'attack', 'move', 'return', 'form_unit']);
const allegiance = new Set(['join', 'join_random', 'found', 'uprising', 'resign', 'accept_invite']);
const stratagems = new Set(['fire_attack', 'sabotage', 'incite']);

function descendants(view: WorldView, id: number) {
  const campaign = readCampaignState(view.campaign, view),
    ids = [id];
  for (let index = 0; index < ids.length; index++)
    ids.push(...campaign.links.filter((link) => link.masterId === ids[index]).map((link) => link.personId));
  return ids;
}
function gate(view: WorldView, actor: Actor, key: string, value: unknown) {
  const general = view.generals[actor.generalId];
  if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
  // 군사·소속을 건드리지 않는 후보 검사에는 휘하 조건이 없다.
  // 실제 실행의 전후 상태 검사는 아래 execute 경로에서 계속 수행한다.
  if (!military.has(key) && !allegiance.has(key)) return null;
  const campaign = readCampaignState(view.campaign, view);
  if (
    general.userId === null &&
    military.has(key) &&
    campaign.links.some((link) => link.personId === general.id) &&
    !hasCampaignOrderAuthority(view, actor, key, value)
  )
    return fail('COMMAND_DISABLED', '휘하 NPC의 군사 행동은 상관의 부곡 명령으로 실행합니다.');
  if (allegiance.has(key)) {
    if (campaign.links.some((link) => link.personId === general.id))
      return fail('BAD_STATE', '휘하 관계를 해제한 뒤 소속을 바꿀 수 있습니다.');
    if (
      descendants(view, general.id)
        .slice(1)
        .some((id) => view.generals[id]!.userId !== null)
    )
      return fail('BAD_STATE', '사람 휘하의 동의 없이 소속을 바꿀 수 없습니다. 먼저 관계를 해제하세요.');
  }
  return null;
}
export { gate as checkCampaignActor };
function preparationDefinition(base: CommandDef, key: CampaignPreparationKey): CommandDef {
  const check = (view: WorldView, actor: Actor, value: unknown) => {
    const outcome = applyCampaignPreparation(view, actor, key, value);
    return outcome.ok ? null : fail(outcome.code, outcome.message);
  };
  return {
    ...base,
    args: key === 'recruit' || key === 'conscript' ? campaignRecruitArgs : campaignDrillArgs,
    check,
    precheck: check,
    execute(view, actor, value) {
      const outcome = applyCampaignPreparation(view, actor, key, value);
      if (!outcome.ok) throw new Error(outcome.message);
      return { ...success(outcome.text), effects: [{ kind: 'world', state: outcome.state }] };
    },
  };
}

// 새 프로필이 운영에 등록될 때만 사용한다. 기존 월드의 CommandDef/해시를 바꾸지 않는다.
export function createCampaignCommandResolver(base: CommandResolver): CommandResolver {
  const overrides = new Map<string, CommandDef>([['attack', campaignAttack]]);
  for (const key of preparation) overrides.set(key, preparationDefinition(base.get(key)!, key));
  const found = base.get('found')!,
    uprising = base.get('uprising')!;
  const checkUprising = (view: WorldView, actor: Actor, value: unknown) =>
    found.check(view, actor, value) ??
    (readCampaignState(view.campaign, view).units.some(
      (unit) =>
        unit.ownerId === actor.generalId &&
        unit.troops > 0 &&
        view.generals[unit.commanderId]!.cityKey === view.generals[actor.generalId]!.cityKey,
    )
      ? null
      : fail('NO_CREW', '거병할 병력이 없습니다.'));
  overrides.set('uprising', {
    ...uprising,
    check: checkUprising,
    precheck: checkUprising,
    execute(view, actor, value, rng) {
      const result = found.execute(view, actor, value, rng);
      return {
        ...result,
        logs: [{ kind: 'success', text: `${(found.args.parse(value) as { name: string }).name} 거병` }],
      };
    },
  });
  function definition(key: string): CommandDef | undefined {
    const original = base.get(key);
    if (!original) return undefined;
    const def = overrides.get(key) ?? original;
    const check = (view: WorldView, actor: Actor, value: unknown) =>
      gate(view, actor, key, value) ?? def.check(view, actor, value);
    return {
      ...def,
      check,
      precheck: (view, actor, value) => gate(view, actor, key, value) ?? def.precheck(view, actor, value),
      execute(view, actor, value, rng): CommandResult {
        const failure = check(view, actor, value);
        if (failure) throw new Error(failure.message);
        const result = def.execute(view, actor, value, rng);
        // 계략의 같은 장수 부상 판정을 실제 지휘 부곡에 적용한다. RNG를 추가로 소비하지 않는다.
        const affected = new Set(
          stratagems.has(key)
            ? result.effects
                .filter((effect) => effect.kind === 'general' && ['crew', 'train', 'atmos'].includes(effect.field))
                .map((effect) => (effect as { id: number }).id)
            : [],
        );
        let state = applyEffects(
          cloneWorld(view),
          result.effects.filter(
            (effect) =>
              !(stratagems.has(key) && effect.kind === 'general' && ['crew', 'train', 'atmos'].includes(effect.field)),
          ),
        );
        if (affected.size) {
          const campaign = readCampaignState(state.campaign, state);
          let changed = false;
          for (const unit of campaign.units) {
            if (!affected.has(unit.commanderId)) continue;
            for (const field of ['troops', 'train', 'atmos'] as const) {
              const next = Math.round(unit[field] * 0.98);
              changed ||= next !== unit[field];
              unit[field] = next;
            }
          }
          if (changed) {
            if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
            campaign.revision++;
          }
          state.campaign = campaign;
        }
        if (allegiance.has(key)) {
          const owner = state.generals[actor.generalId]!;
          for (const id of descendants(view, actor.generalId).slice(1)) {
            const child = state.generals[id]!;
            if (child.nationId !== owner.nationId) {
              if (child.userId !== null) throw new Error('다른 사람의 소속을 강제로 바꿀 수 없습니다.');
              child.nationId = owner.nationId;
              child.officerLevel = owner.nationId === null ? 0 : 1;
            }
          }
        }
        state = followCampaignCommanders(view, state);
        readCampaignState(state.campaign, state);
        return { ...result, effects: [{ kind: 'world', state }] };
      },
    };
  }
  function prepare(view: WorldView, actor: Actor, key: string, value: unknown) {
    const def = definition(key);
    if (!def) return { failure: base.precheck(view, actor, key, value) ?? fail('UNKNOWN_COMMAND', '없는 명령입니다.') };
    if (def.target !== (actor.target ?? 'general')) return { failure: fail('BAD_ARGS', '명령 대상이 다릅니다.') };
    const parsed = def.args.safeParse(value);
    return parsed.success ? { def, args: parsed.data } : { failure: fail('BAD_ARGS', '명령 인자가 잘못되었습니다.') };
  }
  return {
    get: definition,
    list: (target) => base.list(target).map((def) => definition(def.key)!),
    precheck(view, actor, key, value) {
      const parsed = prepare(view, actor, key, value);
      return parsed.failure ?? parsed.def!.precheck(view, actor, parsed.args);
    },
    run(view, actor, key, value, rng: Rng) {
      const parsed = prepare(view, actor, key, value);
      return (
        parsed.failure ??
        parsed.def!.check(view, actor, parsed.args) ??
        parsed.def!.execute(view, actor, parsed.args, rng)
      );
    },
  };
}
