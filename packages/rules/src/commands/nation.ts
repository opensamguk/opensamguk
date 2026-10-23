import { z } from 'zod';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { refreshSupply } from '../supply';
import { defineCommand, fail, noArgs, positive, relation, success } from './support';

const resourceArgs = z.strictObject({ generalId: positive, resource: z.enum(['gold', 'rice']), amount: positive });
const resourceTransfer = (seize: boolean) =>
  defineCommand({
    key: seize ? 'nation_seize' : 'nation_reward',
    name: seize ? '몰수' : '포상',
    category: 'nation',
    target: 'nation',
    args: resourceArgs,
    check(view, actor, args) {
      const g = view.generals[actor.generalId]!;
      const target = view.generals[args.generalId];
      if (!target || target.nationId !== g.nationId) return fail('BAD_TARGET', '자기 국가 장수만 가능합니다.');
      const source = seize ? target : view.nations[g.nationId!]!;
      return source[args.resource] < args.amount
        ? fail(args.resource === 'gold' ? 'NO_GOLD' : 'NO_RICE', '자원이 부족합니다.')
        : null;
    },
    change(state, actor, args) {
      const nation = state.nations[state.generals[actor.generalId]!.nationId!]!;
      const target = state.generals[args.generalId]!;
      const delta = seize ? -args.amount : args.amount;
      nation[args.resource] -= delta;
      target[args.resource] += delta;
      return success(
        `${target.name} ${seize ? '몰수' : '포상'}: ${args.resource === 'gold' ? '금' : '쌀'} ${args.amount}`,
      );
    },
  });
type Proposal = 'peace' | 'pact' | 'break' | 'aid';
const proposals: Record<Proposal, { key: string; name: string }> = {
  peace: { key: 'nation_peace', name: '종전 제의' },
  pact: { key: 'nation_pact', name: '불가침 제의' },
  break: { key: 'nation_break_pact', name: '불가침 파기 제의' },
  aid: { key: 'nation_aid', name: '원조' },
};
const proposal = (kind: Proposal) =>
  defineCommand({
    ...proposals[kind],
    category: 'nation',
    target: 'nation',
    args: z.strictObject({
      nationId: positive,
      resource: z.enum(['gold', 'rice']).optional(),
      amount: positive.optional(),
    }),
    check(view, actor, args) {
      const g = view.generals[actor.generalId]!;
      const nation = view.nations[g.nationId!]!;
      if (!view.nations[args.nationId] || args.nationId === nation.id)
        return fail('BAD_TARGET', '다른 국가를 골라야 합니다.');
      const d = relation(view, nation.id, args.nationId);
      if (kind === 'peace' && d?.state !== 'WAR') return fail('NOT_WAR', '교전 중인 국가가 아닙니다.');
      if (kind === 'pact' && d) return fail('BAD_STATE', '중립 국가에만 불가침을 제의할 수 있습니다.');
      if (kind === 'break' && d?.state !== 'NON_AGGRESSION') return fail('BAD_STATE', '불가침 중인 국가가 아닙니다.');
      if (kind === 'aid') {
        if (!args.resource || !args.amount) return fail('BAD_ARGS', '원조 자원과 수량을 입력하세요.');
        if (d?.state === 'WAR' || d?.state === 'DECLARED')
          return fail('BAD_STATE', '교전 상대에게 원조할 수 없습니다.');
        if (nation[args.resource] < args.amount)
          return fail(args.resource === 'gold' ? 'NO_GOLD' : 'NO_RICE', '원조 자원이 부족합니다.');
      }
      return null;
    },
    change(state, actor, args) {
      const nation = state.nations[state.generals[actor.generalId]!.nationId!]!;
      const other = state.nations[args.nationId]!;
      // M1 NPC: 평화·불가침·원조는 수락, 불가침 파기는 거절한다. 사람 상대는 제안만 기록한다.
      const accepted = other.isNpc && kind !== 'break';
      if (accepted) {
        if (kind === 'peace' || kind === 'pact') {
          state.diplomacies = state.diplomacies.filter(
            (d) => !(d.nationA === Math.min(nation.id, other.id) && d.nationB === Math.max(nation.id, other.id)),
          );
          if (kind === 'pact')
            state.diplomacies.push({
              nationA: Math.min(nation.id, other.id),
              nationB: Math.max(nation.id, other.id),
              state: 'NON_AGGRESSION',
              untilTick: (actor.tick ?? 0) + BALANCE.TREATY_MONTHS * TICKS_PER_MONTH,
            });
          state.diplomacies.sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB);
        } else if (kind === 'aid') {
          nation[args.resource!] -= args.amount!;
          other[args.resource!] += args.amount!;
        }
      }
      const quantity = kind === 'aid' ? ` ${args.resource === 'gold' ? '금' : '쌀'} ${args.amount}` : '';
      const text = `${nation.name} → ${other.name} ${proposals[kind].name}${quantity}: ${other.isNpc ? (accepted ? '수락' : '거절') : '응답 대기'}`;
      return {
        ...success(text),
        history: [
          { nationId: nation.id, text },
          { nationId: other.id, text },
        ],
      };
    },
  });
export const nationCommands = [
  defineCommand({
    key: 'nation_rest',
    name: '휴식',
    category: 'nation',
    target: 'nation',
    args: noArgs,
    check: () => null,
    change: () => success('국가 휴식'),
  }),
  resourceTransfer(false),
  resourceTransfer(true),
  defineCommand({
    key: 'nation_assign',
    name: '발령',
    category: 'nation',
    target: 'nation',
    args: z.strictObject({ generalId: positive, cityKey: positive }),
    check(view, actor, args) {
      const nationId = view.generals[actor.generalId]!.nationId;
      return view.generals[args.generalId]?.nationId === nationId && view.cities[args.cityKey]?.nationId === nationId
        ? null
        : fail('BAD_TARGET', '소속 장수와 자기 국가 도시를 골라야 합니다.');
    },
    change(state, _actor, args) {
      const g = state.generals[args.generalId]!;
      g.cityKey = args.cityKey;
      return success(`${g.name} ${state.cities[args.cityKey]!.name} 발령`);
    },
  }),
  defineCommand({
    key: 'nation_capital',
    name: '천도',
    category: 'nation',
    target: 'nation',
    args: z.strictObject({ cityKey: positive }),
    check(view, actor, args) {
      const nation = view.nations[view.generals[actor.generalId]!.nationId!]!;
      if (view.cities[args.cityKey]?.nationId !== nation.id)
        return fail('NOT_OWN_CITY', '자기 국가 도시만 수도로 정할 수 있습니다.');
      return nation.capitalCityKey === args.cityKey ? fail('BAD_STATE', '이미 수도입니다.') : null;
    },
    change(state, actor, args) {
      state.nations[state.generals[actor.generalId]!.nationId!]!.capitalCityKey = args.cityKey;
      refreshSupply(state);
      return success(`${state.cities[args.cityKey]!.name} 천도`);
    },
  }),
  defineCommand({
    key: 'nation_declare',
    name: '선전포고',
    category: 'nation',
    target: 'nation',
    args: z.strictObject({ nationId: positive }),
    check(view, actor, args) {
      if (Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) < (view.presetRules?.protection.peaceMonths ?? 0))
        return fail('PROTECTED', '초반 보호 기간에는 선전포고할 수 없습니다.');
      const id = view.generals[actor.generalId]!.nationId!;
      if (!view.nations[args.nationId] || args.nationId === id) return fail('BAD_TARGET', '다른 국가를 골라야 합니다.');
      return relation(view, id, args.nationId) ? fail('BAD_STATE', '중립 국가에만 선전포고할 수 있습니다.') : null;
    },
    change(state, actor, args) {
      const id = state.generals[actor.generalId]!.nationId!;
      state.diplomacies.push({
        nationA: Math.min(id, args.nationId),
        nationB: Math.max(id, args.nationId),
        state: 'DECLARED',
        untilTick: (actor.tick ?? 0) + BALANCE.DECLARE_MONTHS * TICKS_PER_MONTH,
      });
      state.diplomacies.sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB);
      const text = `${state.nations[id]!.name} → ${state.nations[args.nationId]!.name} 선전포고`;
      return {
        ...success(text),
        history: [
          { nationId: id, text },
          { nationId: args.nationId, text },
        ],
      };
    },
  }),
  proposal('peace'),
  proposal('pact'),
  proposal('break'),
  proposal('aid'),
];
