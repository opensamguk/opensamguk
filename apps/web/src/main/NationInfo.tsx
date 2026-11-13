import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { formatYearMonth, personalLogDate } from '../game/gameDate';
import { displayName, officerName } from '../game/names';
import { useWorldMap, useWorldRules, useWorldSummary } from '../game/queries';
import { QueryError } from '../game/QueryState';
import {
  isDetailedCity,
  isDetailedGeneral,
  isMemberNation,
  type Home,
  type MapCity,
  type NationView,
  type WorldSummary,
} from '../game/types';
import { NationNoticeBox } from '../messages/NationNotice';
import type { InspectionRow } from '../operations/contract';
import type { ArgNames } from '../turns/args';
import { formatTime, slotTimes } from '../turns/schedule';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import {
  BandText,
  GeneralNameCell,
  TURNS_OFFICER_ONLY,
  TurnFive,
  useArgNames,
  useCity,
  useInspectionRows,
} from './CityInfo';
import { displayedAge } from './GeneralInfo';
import {
  armyOf,
  cityBands,
  cityLevelText,
  nationHeads,
  nationTotals,
  populationRate,
  techText,
  type ArmyFields,
} from './infoView';
import { InfoGrid } from './Panel';
import { unitNameOf } from './UnitName';
import styles from './NationInfo.module.css';

const HIDDEN_NATION = '다른 국가 정보';
const n = (value: number) => value.toLocaleString('ko-KR');

type NationSummary = NonNullable<Home['nation']> | NationView;
type FinanceEstimate = NonNullable<NationView['financeEstimate']>;
type NationGenerals = NationView['generals'];
// 공개 국력과 순위 (ranking.nations, 달마다 찍은 값). 아직 정산 전이면 null이다.
export type NationPower = { power: number; rank: number; at: string } | null;

// 국가 요약 칸이다. 원작 국가 카드처럼 군주·참모·총 병사·국력을 앞에 둔다.
// 소속국만 국고·군량·세율·기술과 장수 직책·병력을 받는다. 다른 국가는 —와 이유를 보여 준다.
export function NationSummaryGrid({
  nation,
  capitalName,
  generals,
  power,
}: {
  nation: NationSummary;
  capitalName?: string | undefined;
  generals?: NationGenerals | undefined;
  power?: NationPower | undefined;
}) {
  const member = isMemberNation(nation);
  const hidden = { value: '—', title: HIDDEN_NATION };
  const detailed = generals?.filter(isDetailedGeneral) ?? [];
  const heads = generals ? nationHeads(detailed) : undefined;
  const totals = member && generals ? nationTotals(detailed) : null;
  const headValue = (name: string | null | undefined) => (name ? displayName(name) : '—');
  // 성향은 모든 국가에 공개된다 (nation.get philosophy, INT-26). 홈 응답처럼 값이 없으면 소속국만 보인다.
  const philosophy = 'philosophy' in nation ? nation.philosophy : undefined;
  const strategy = 'strategyStatus' in nation ? nation.strategyStatus : undefined;
  const aid = 'diplomaticAid' in nation ? nation.diplomaticAid : undefined;
  // 총 주민은 nation.get이 모든 국가에 준다 (소유 도시 주민 합계 / 최대, INT-26).
  const population =
    'populationMax' in nation && typeof nation.population === 'number' && typeof nation.populationMax === 'number'
      ? { value: nation.population, max: nation.populationMax }
      : null;
  return (
    <InfoGrid
      items={[
        member ? { label: '군주', value: headValue(heads?.ruler) } : { label: '군주', ...hidden },
        member ? { label: '참모', value: headValue(heads?.advisor) } : { label: '참모', ...hidden },
        { label: '작위', value: nation.rank?.title ?? '—' },
        { label: '속령', value: n(nation.cityCount) },
        { label: '장수', value: n(nation.generalCount) },
        population
          ? {
              label: '총 주민',
              value: `${n(population.value)} / ${n(population.max)}`,
              title: '소유 도시 주민 합계 / 최대 주민 합계',
              wide: true,
            }
          : { label: '총 주민', value: '—', title: '국가 정보를 불러오는 중입니다', wide: true },
        member
          ? {
              label: '총 병사',
              value: totals ? `${n(totals.troops)} / ${n(totals.maxTroops)}` : '—',
              title: '소속 장수 병력 합계 / 통솔 합계 × 100',
            }
          : { label: '총 병사', ...hidden },
        power
          ? { label: '국력', value: `${n(power.power)} · ${power.rank}위`, title: power.at }
          : { label: '국력', value: '—', title: '월간 정산 뒤에 보입니다' },
        member ? { label: '국고', value: n(nation.gold) } : { label: '국고', ...hidden },
        member ? { label: '군량', value: n(nation.rice) } : { label: '군량', ...hidden },
        member ? { label: '세율', value: `${Math.round(nation.taxRate * 100)}%` } : { label: '세율', ...hidden },
        member ? { label: '기술', value: techText(nation.tech) } : { label: '기술', ...hidden },
        ...(aid
          ? [{ label: '외교 원조', value: aid.remainingMonths ? `${aid.remainingMonths}개월 대기` : '대기 없음' }]
          : []),
        ...(strategy
          ? [
              {
                label: '전략',
                wide: true,
                value: (
                  <details>
                    <summary>
                      {strategy.remainingMonths ? `${strategy.remainingMonths}개월 대기` : '공통 대기 없음'}
                    </summary>
                    <ul>
                      {strategy.commands.map((command) => (
                        <li key={command.key}>
                          {command.name} ·{' '}
                          {command.availableAt
                            ? `${command.remainingMonths}개월 대기 (${command.availableAt.year}년 ${command.availableAt.month}월)`
                            : '대기 없음'}
                        </li>
                      ))}
                    </ul>
                  </details>
                ),
              },
            ]
          : []),
        // 수도는 지도 응답(world.map)에 모든 국가 것이 있어 다른 국가도 보인다 (원작 세력일람의 [수도]).
        { label: '수도', value: capitalName ?? '—' },
        philosophy !== undefined ? { label: '성향', value: philosophy || '—' } : { label: '성향', ...hidden },
      ]}
    />
  );
}

export function NationNpcPolicy({ worldId, nation }: { worldId: string; nation: NationView }) {
  const policy = nation.npcPolicy;
  if (!policy) return null;
  return (
    <details>
      <summary>NPC 운영 기준</summary>
      {policy.editor ? (
        <NationNpcPolicyEditor key={`${worldId}:${nation.id}`} worldId={worldId} nationId={nation.id} policy={policy} />
      ) : null}
      <InfoGrid
        items={[
          { label: '전선 모집 목표', value: `${n(policy.recruitTarget)}명` },
          { label: '훈련 목표', value: n(policy.trainingTarget) },
          { label: '사기 목표', value: n(policy.moraleTarget) },
          { label: '포상 기준 금', value: n(policy.rewardGoldTarget) },
          { label: '출병·선전포고 점수 배율', value: `×${n(policy.aggression)}` },
        ]}
      />
      {policy.history?.length ? (
        <section>
          <h3>정책 변경 이력</h3>
          {policy.history.map(({ sequence, date, requestedAt, generalName, previous, current }) => (
            <details key={sequence}>
              <summary>
                {date.year}년 {date.month}월 · {generalName ?? '장수 정보 없음'} ·{' '}
                <time dateTime={requestedAt}>{new Date(requestedAt).toLocaleString('ko-KR')}</time>
              </summary>
              <ul>
                {(Object.keys(npcPolicyLabels) as Array<keyof NationNpcSettings>)
                  .filter((field) => previous?.[field] !== current[field])
                  .map((field) => (
                    <li key={field}>
                      {npcPolicyLabels[field]} · {previous?.[field] ?? '—'} → {current[field] ?? '—'}
                    </li>
                  ))}
                {(['generalPriority', 'nationPriority'] as const)
                  .filter((field) => JSON.stringify(previous?.[field]) !== JSON.stringify(current[field]))
                  .map((field) => (
                    <li key={field}>
                      {field === 'generalPriority' ? '장수 명령 순서' : '국가 명령 순서'} ·{' '}
                      {previous === null ? '—' : npcPriorityText(previous[field])} → {npcPriorityText(current[field])}
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </section>
      ) : null}
      {[
        { label: '현재 국가 명령 후보', orders: policy.nationOrders },
        { label: '현재 NPC 장수 명령 후보', orders: policy.generalOrders },
      ].map(({ label, orders }) =>
        orders?.length ? (
          <section key={label}>
            <h3>{label}</h3>
            <ol>
              {orders.map(({ key, name, score, reason }) => (
                <li key={key}>
                  {name} · {n(score)}점 · {reason}
                </li>
              ))}
            </ol>
          </section>
        ) : null,
      )}
    </details>
  );
}

type NationNpcSettings = NonNullable<NonNullable<NationView['npcPolicy']>['editor']>['limits'];
const npcPriorityText = (priority: readonly string[] | undefined) =>
  priority === undefined ? '기본 순서' : priority.join(', ') || '모두 끔';
const npcPolicyLabels = {
  recruitTarget: '전선 모집 목표',
  trainingTarget: '훈련 목표',
  moraleTarget: '사기 목표',
  rewardGoldTarget: '포상 기준 금',
  rewardRiceTarget: '포상 기준 쌀',
  reserveRice: '포상 뒤 보유할 국고 쌀',
  seizeGoldAbove: 'NPC 몰수 뒤 보유할 금',
  seizeRiceAbove: 'NPC 몰수 뒤 보유할 쌀',
  minRecruitPopulation: '모집 최소 도시 인구',
  safeRecruitPopulationPercent: '모집 최소 도시 인구율 (%)',
  reserveGold: '포상 뒤 보유할 국고 금',
  minReward: '최소 포상·몰수 단위',
  maxReward: '최대 포상·몰수 단위',
  minWarCrew: '출병 최소 병력',
  minNpcWarLeadership: '전투 참여 최소 통솔',
  cureThreshold: '요양 기준 부상',
} satisfies Record<keyof NationNpcSettings, string>;

function NationNpcPolicyEditor({
  worldId,
  nationId,
  policy,
}: {
  worldId: string;
  nationId: number;
  policy: NonNullable<NationView['npcPolicy']>;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Partial<Record<keyof NationNpcSettings, string>>>({});
  const save = useMutation(
    trpc.nation.setNpcPolicy.mutationOptions({
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: trpc.nation.get.queryKey({ worldId, nationId }) });
        setDraft({});
        setPriorities({});
      },
    }),
  );
  const [priorities, setPriorities] = useState<{ general?: string[] | null; nation?: string[] | null }>({});
  const editor = policy.editor;
  if (!editor) return null;
  const fields = Object.keys(npcPolicyLabels) as Array<keyof NationNpcSettings>;
  const value = (field: keyof NationNpcSettings) =>
    draft[field] ?? String(editor.pending?.[field] ?? policy[field] ?? '');
  const generalPriority = editor.pending ? editor.pending.generalPriority : policy.generalPriority;
  const nationPriority = editor.pending ? editor.pending.nationPriority : policy.nationPriority;
  const priorityFor = (kind: 'general' | 'nation') =>
    priorities[kind] === null
      ? undefined
      : (priorities[kind] ?? (kind === 'general' ? generalPriority : nationPriority));
  const names: Record<string, string> = {
    join: '임관',
    return: '귀환',
    move: '이동',
    farm: '농지 개간',
    commerce: '상업 투자',
    security: '치안 강화',
    settle: '정착 장려',
    goodwill: '민심 수습',
    defence: '수비 강화',
    wall: '성벽 보수',
    research: '기술 연구',
    form_unit: '빈 부곡 편성',
    recruit: '모병',
    train: '훈련',
    morale: '사기진작',
    trade_rice: '군량 매입',
    attack: '출병',
    heal: '요양',
    nation_capital: '천도',
    nation_declare: '선전포고',
    nation_reward: '포상',
    nation_seize: 'NPC 몰수',
    nation_city_allocate: '도시 병력 배속',
    nation_mobilize: '백성동원',
    nation_rivalry: '피장파장',
    nation_raid: '기습',
  };
  const changePriority = (kind: 'general' | 'nation', key: string, direction: -1 | 0 | 1) => {
    const current = [...(priorityFor(kind) ?? editor.commands[kind])];
    const index = current.indexOf(key);
    if (direction === 0) {
      if (index < 0) current.push(key);
      else current.splice(index, 1);
    } else if (index >= 0 && index + direction >= 0 && index + direction < current.length) {
      [current[index], current[index + direction]] = [current[index + direction]!, current[index]!];
    }
    setPriorities((previous) => ({ ...previous, [kind]: current }));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (editor.pending) return;
        save.mutate({
          worldId,
          nationId,
          policy: {
            recruitTarget: Number(value('recruitTarget')),
            trainingTarget: Number(value('trainingTarget')),
            moraleTarget: Number(value('moraleTarget')),
            rewardGoldTarget: Number(value('rewardGoldTarget')),
            ...Object.fromEntries(
              fields
                .slice(4)
                .filter((key) => value(key) !== '')
                .map((key) => [key, Number(value(key))]),
            ),
            generalPriority: priorityFor('general')?.filter((key): key is NonNullable<typeof generalPriority>[number] =>
              (editor.commands.general as readonly string[]).includes(key),
            ),
            nationPriority: priorityFor('nation')?.filter((key): key is NonNullable<typeof nationPriority>[number] =>
              (editor.commands.nation as readonly string[]).includes(key),
            ),
          },
        });
      }}
    >
      <fieldset disabled={save.isPending || editor.pending !== null}>
        <legend>NPC 운영 기준 편집</legend>
        {fields.map((field) => (
          <label key={field}>
            {npcPolicyLabels[field]}{' '}
            <input
              type="number"
              min={editor.limits[field].min}
              max={editor.limits[field].max}
              step={1}
              required={fields.indexOf(field) < 4}
              value={value(field)}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setDraft((previous) => ({ ...previous, [field]: next }));
              }}
            />
          </label>
        ))}
        {(['general', 'nation'] as const).map((kind) => {
          const order = priorityFor(kind);
          const commands: readonly string[] = editor.commands[kind];
          const active = order ?? commands;
          const all = [...active, ...commands.filter((key) => !active.includes(key))];
          return (
            <details key={kind}>
              <summary>{kind === 'general' ? 'NPC 장수 명령 우선순위' : 'NPC 국가 명령 우선순위'}</summary>
              <button
                type="button"
                disabled={order === undefined}
                onClick={() => setPriorities((previous) => ({ ...previous, [kind]: null }))}
              >
                기본 순서로 되돌리기
              </button>
              {order === undefined ? <p>상황에 따라 기본 순서를 적용합니다.</p> : null}
              <ol>
                {all.map((key) => {
                  const index = active.indexOf(key);
                  return (
                    <li key={key}>
                      <label>
                        <input type="checkbox" checked={index >= 0} onChange={() => changePriority(kind, key, 0)} />
                        {names[key] ?? key}
                      </label>{' '}
                      <button
                        type="button"
                        aria-label={`${names[key] ?? key} 위로`}
                        disabled={index <= 0}
                        onClick={() => changePriority(kind, key, -1)}
                      >
                        ↑
                      </button>{' '}
                      <button
                        type="button"
                        aria-label={`${names[key] ?? key} 아래로`}
                        disabled={index < 0 || index >= active.length - 1}
                        onClick={() => changePriority(kind, key, 1)}
                      >
                        ↓
                      </button>
                    </li>
                  );
                })}
              </ol>
            </details>
          );
        })}
        <button type="submit" disabled={Object.keys(draft).length === 0 && Object.keys(priorities).length === 0}>
          저장
        </button>
      </fieldset>
      {editor.pending ? <p role="status">NPC 운영 기준 변경을 처리하고 있습니다.</p> : null}
      {save.isError ? <p role="alert">{save.error.message}</p> : null}
    </form>
  );
}

export function NationRestrictions({ worldId, nation }: { worldId: string; nation: NationView }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const save = useMutation(
    trpc.nation.setRestrictions.mutationOptions({
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: trpc.nation.get.queryKey({ worldId, nationId: nation.id }) });
      },
    }),
  );
  const restrictions = nation.restrictions;
  if (!restrictions) return null;
  const editor = restrictions.editor;
  const change = (setting: 'recruitment' | 'war', blocked: boolean) =>
    save.mutate({ worldId, nationId: nation.id, setting, blocked });
  return (
    <section aria-label="임관과 출병">
      <InfoGrid
        items={[
          { label: '임관', value: restrictions.recruitmentBlocked ? '금지' : '허용' },
          ...(restrictions.warBlocked === undefined
            ? []
            : [{ label: '출병', value: restrictions.warBlocked ? '금지' : '허용' }]),
        ]}
      />
      {editor ? (
        <>
          <button
            type="button"
            disabled={save.isPending || editor.pending !== null}
            onClick={() => change('recruitment', !restrictions.recruitmentBlocked)}
          >
            {restrictions.recruitmentBlocked ? '임관 허용' : '임관 금지'}
          </button>{' '}
          <button
            type="button"
            disabled={save.isPending || editor.pending !== null || editor.warChanges === 0}
            onClick={() => change('war', !restrictions.warBlocked)}
          >
            {restrictions.warBlocked ? '출병 허용' : '출병 금지'}
          </button>{' '}
          <small>출병 제한 변경 {editor.warChanges}회 남음</small>
        </>
      ) : null}
      {editor?.pending ? <p role="status">국가 제한 변경을 처리하고 있습니다.</p> : null}
      {save.isError ? <p role="alert">{save.error.message}</p> : null}
    </section>
  );
}

const signed = (value: number) => `${value < 0 ? '−' : '+'}${n(Math.abs(value))}`;
const due = (row: FinanceEstimate['gold']) => `${row.year}년 ${row.month}월`;

// 다음 세금·세곡 예상과 봉급·순수입 (nation.get financeEstimate, INT-26). 소속국에만 온다.
// 원작 국가 카드의 세금·세곡·지급률·예산 줄을 글자와 숫자로 쓴다 (색만으로 뜻을 전하지 않는다).
export function NationFinanceGrid({ nation }: { nation: NationSummary }) {
  const estimate = 'financeEstimate' in nation ? nation.financeEstimate : undefined;
  if (!estimate) return null;
  const rate = 'salaryRate' in nation && typeof nation.salaryRate === 'number' ? nation.salaryRate : undefined;
  const { gold, rice } = estimate;
  const toCity = estimate.destination === 'city';
  return (
    <div className={styles.finance} data-testid="nation-finance">
      <p className={styles.financeTitle}>다음 정산 예상</p>
      <InfoGrid
        items={[
          { label: '세금', value: `금 ${n(gold.gross)} · ${due(gold)}`, title: '상업·주민으로 걷는 금', wide: true },
          { label: '세곡', value: `쌀 ${n(rice.gross)} · ${due(rice)}`, title: '농업·주민으로 걷는 쌀', wide: true },
          {
            label: rate === undefined ? '봉급' : `봉급(지급률 ${Math.round(rate * 100)}%)`,
            value: `금 ${n(gold.payroll)} · 쌀 ${n(rice.payroll)}`,
            title: '세입 가운데 소속 장수에게 나눠 주는 몫',
            wide: true,
          },
          {
            label: estimate.rankedPayroll ? '평균 봉급' : '1인 봉급',
            value: `금 ${n(gold.perGeneral)} · 쌀 ${n(rice.perGeneral)}`,
            wide: true,
          },
          {
            label: toCity ? '순수입(도시 창고)' : '순수입(국고)',
            value: `금 ${signed(gold.net)} · 쌀 ${signed(rice.net)}`,
            title: toCity ? '봉급을 뺀 나머지가 각 도시 창고로 들어갑니다' : '봉급을 뺀 나머지가 국고로 들어갑니다',
            wide: true,
          },
        ]}
      />
    </div>
  );
}

function NationFinanceEditor({ worldId, nation }: { worldId: string; nation: NationView }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [tax, setTax] = useState<number>();
  const [salary, setSalary] = useState<number>();
  const save = useMutation(
    trpc.nation.setFinanceRates.mutationOptions({
      onSuccess: async () => {
        setTax(undefined);
        setSalary(undefined);
        await client.invalidateQueries({ queryKey: trpc.nation.get.queryKey({ worldId, nationId: nation.id }) });
      },
    }),
  );
  const editor = nation.financeEditor;
  if (!editor) return null;
  const taxPercent =
    tax ?? editor.pending?.taxPercent ?? Math.round(('taxRate' in nation ? nation.taxRate : 0.2) * 100);
  const salaryPercent = salary ?? editor.pending?.salaryPercent ?? Math.round((nation.salaryRate ?? 0.5) * 100);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ worldId, nationId: nation.id, rates: { taxPercent, salaryPercent } });
      }}
    >
      <fieldset disabled={save.isPending || editor.pending !== null}>
        <legend>세율·지급률 설정</legend>
        <label>
          세율 (%){' '}
          <input
            type="number"
            required
            min={5}
            max={30}
            value={taxPercent}
            onChange={(event) => setTax(Number(event.target.value))}
          />
        </label>
        <label>
          지급률 (%){' '}
          <input
            type="number"
            required
            min={20}
            max={200}
            value={salaryPercent}
            onChange={(event) => setSalary(Number(event.target.value))}
          />
        </label>
        <button type="submit">저장</button>
      </fieldset>
      {editor.pending ? <p role="status">세율·지급률 변경을 처리하고 있습니다.</p> : null}
      {save.error ? <p role="alert">{save.error.message}</p> : null}
    </form>
  );
}

export function useNation(worldId: string, nationId: number, enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.nation.get.queryOptions({ worldId, nationId }),
    enabled,
    retry: retryUnlessClientError,
    refetchInterval: (query) =>
      query.state.data?.npcPolicy?.editor?.pending ||
      query.state.data?.restrictions?.editor?.pending ||
      query.state.data?.financeEditor?.pending
        ? 1000
        : false,
  });
}

// 공개 국력과 그 순위. 순위 화면과 같은 조회(ranking.nations, 국력 기준)에서 이 국가 줄을 읽는다.
export function useNationPower(worldId: string, nationId: number | null): NationPower | undefined {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.ranking.nations.queryOptions({ worldId, by: 'power' }),
    enabled: nationId !== null,
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
  if (!query.data) return undefined;
  const at = query.data.at;
  const row = query.data.items.find((item) => item.nationId === nationId);
  return row && at ? { power: row.power, rank: row.rank, at: `${at.year}년 ${at.month}월 정산 기준` } : null;
}

// 모든 국가의 수도 이름. 지도 응답의 capitalCityKey를 쓴다.
export function capitalNameOf(map: ReturnType<typeof useWorldMap>['data'], nationId: number) {
  const key = map?.nations.find((nation) => nation.id === nationId)?.capitalCityKey;
  return key == null ? undefined : map?.cities.find((city) => city.key === key)?.name;
}

// 국가 소개와 방랑 표시. 소개는 시나리오가 준 국가 설명(소속국만 받는다), 방랑은 nation-lifecycle-v1 월드의 기한이다.
export function NationExtras({ worldId, nation }: { worldId: string; nation: NationSummary | NationView }) {
  const summary = useWorldSummary(worldId).data;
  const map = useWorldMap(worldId).data;
  const wandering = 'wandering' in nation ? nation.wandering : null;
  const description = isMemberNation(nation) ? nation.description.trim() : '';
  const generals: NationGenerals = 'generals' in nation ? (nation.generals as NationGenerals) : [];
  const ruler = generals.filter(isDetailedGeneral).find((g) => g.officerLevel === 12);
  const rulerCity = ruler ? map?.cities.find((city) => city.key === ruler.cityKey)?.name : undefined;
  if (!wandering && description === '') return null;
  return (
    <div className={styles.extras}>
      {wandering ? (
        <p className={styles.extraLine} data-testid="nation-wandering">
          <Tag tone="warning">방랑 중</Tag>
          <span>
            {summary ? `${formatYearMonth(personalLogDate(wandering.expiresTick, summary))}까지` : '기한 확인 중'}
            {rulerCity ? ` · 현재 위치 ${rulerCity}` : ''}
          </span>
        </p>
      ) : null}
      {description ? (
        <p className={styles.extraLine} data-testid="nation-description">
          <span className={styles.extraLabel}>국가 소개</span>
          <span>{description}</span>
        </p>
      ) : null}
    </div>
  );
}

// 메인의 국가 정보 칸. 요약만 보이고, 소속 장수·소유 도시 표와 통치는 전용 화면 링크로 잇는다 (INT-25).
export function NationInfo({
  worldId,
  nation,
  cities,
  nations,
  presence,
}: {
  worldId: string;
  nation: Home['nation'];
  cities: readonly MapCity[];
  nations: readonly { id: number; name: string }[];
  presence: Home['presence'];
}) {
  const detail = useNation(worldId, nation?.id ?? 1, nation !== null);
  const power = useNationPower(worldId, nation?.id ?? null);
  const onlineNations = nations
    .filter(({ id }) => presence?.nationIds.includes(id))
    .map(({ name }) => displayName(name));
  const presenceGrid = (
    <InfoGrid
      items={[
        { label: '접속 중인 국가', value: onlineNations.join(', ') || '—' },
        ...(nation && presence
          ? [
              {
                label: '접속 중인 우리 장수',
                value: presence.allies.map(({ name }) => displayName(name)).join(', ') || '—',
              },
            ]
          : []),
      ]}
    />
  );
  // 통치(황실·정통성)는 전용 화면으로 옮겼다 (INT-25). 재야 장수도 링크로 공개 정보를 본다.
  if (nation === null)
    return (
      <>
        <EmptyState title="재야입니다">국가에 임관하면 국고·군량과 소속 장수를 여기서 봅니다.</EmptyState>
        {presenceGrid}
        <p className={styles.links}>
          <Link to="/w/$worldId/nation/governance" params={{ worldId }}>
            통치
          </Link>
        </p>
      </>
    );
  const capital = isMemberNation(nation) ? cities.find((city) => city.key === nation.capitalCityKey) : undefined;
  return (
    <div className={styles.nation} data-nation-id={nation.id}>
      <div className={styles.title} style={{ background: nation.color }}>
        <NationBadge name={nation.name} color={nation.color} />
        <Link
          to="/w/$worldId/nation/$nationId"
          params={{ worldId, nationId: String(nation.id) }}
          className={styles.more}
        >
          국가 화면
        </Link>
      </div>
      {/* 성향·총 주민·정산 예상은 nation.get 값이다 (INT-26). 받기 전에는 홈 응답 값으로 그린다. */}
      <NationSummaryGrid
        nation={detail.data ?? nation}
        capitalName={capital?.name}
        generals={detail.data?.generals}
        power={power}
      />
      {detail.data ? <NationFinanceGrid nation={detail.data} /> : null}
      {detail.data ? <NationFinanceEditor key={detail.data.id} worldId={worldId} nation={detail.data} /> : null}
      <NationExtras worldId={worldId} nation={detail.data ?? nation} />
      {/* 소속 장수·도시 표와 통치는 전용 화면으로 옮겼다 (INT-25). */}
      <p className={styles.links}>
        <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(nation.id) }}>
          세력 장수 {n(nation.generalCount)}명
        </Link>
        <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(nation.id) }} hash="cities">
          세력 도시 {n(nation.cityCount)}곳
        </Link>
        <Link to="/w/$worldId/nation/governance" params={{ worldId }}>
          통치
        </Link>
      </p>
      {presenceGrid}
      <NationNoticeBox worldId={worldId} />
    </div>
  );
}

// 소속 장수 합계 (원작 암행부 요약 표). 같은 국가 장수의 금·쌀·병력을 화면에서 더한다.
export function NationTotalsGrid({ generals }: { generals: NationGenerals }) {
  const totals = nationTotals(generals.filter(isDetailedGeneral));
  const ready = (row: { troops: number; count: number }) => `${n(row.troops)}명 (${n(row.count)}장수)`;
  return (
    <div data-testid="nation-totals">
      <InfoGrid
        items={[
          { label: '장수 금', value: `${n(totals.gold)} (평균 ${n(totals.averageGold)})` },
          { label: '장수 쌀', value: `${n(totals.rice)} (평균 ${n(totals.averageRice)})` },
          { label: '병력', value: `${n(totals.troops)} / ${n(totals.maxTroops)}` },
          { label: '병력 있는 장수', value: `${n(totals.withTroops)} / ${n(totals.count)}명` },
          { label: '훈련·사기 90 이상', value: ready(totals.ready90) },
          { label: '훈련·사기 80 이상', value: ready(totals.ready80) },
          { label: '훈련·사기 60 이상', value: ready(totals.ready60) },
        ]}
      />
    </div>
  );
}

// 국가의 소유 도시·소속 장수 표. 관리가 필요한 칸은 글자 표시와 색을 함께 쓴다.
export function NationTables({
  worldId,
  nationId,
  onSelectCity,
}: {
  worldId: string;
  nationId: number;
  onSelectCity?: (key: number) => void;
}) {
  const query = useNation(worldId, nationId);
  const map = useWorldMap(worldId).data;
  const summary = useWorldSummary(worldId).data;
  const crewTypes = useWorldRules(worldId).data?.unitSet.crewTypes;
  // 소유 도시 표에서 펼친 도시 (원작 세력 도시의 암행부 연동). 한 번에 한 도시만 펼친다.
  const [openCity, setOpenCity] = useState<number | null>(null);
  const panelId = useId();
  // 예턴·다음 턴 시각·NPC 여부는 감찰 자료다. 이 국가 소속 직책자만 받는다.
  const inspection = useInspectionRows(worldId, nationId);
  const names = useArgNames(worldId);
  if (query.isPending) return <LoadingState />;
  if (query.isError)
    return <QueryError error={query.error} notFound="없는 국가입니다" onRetry={() => void query.refetch()} />;
  const data = query.data;
  const campaign = 'campaignEnabled' in data && data.campaignEnabled;
  const fiveStats = 'fiveStats' in data && data.fiveStats;
  // 수도는 지도 응답에 모든 국가 것이 있다. 소속국 응답의 값을 먼저 쓴다.
  const capitalKey = isMemberNation(data)
    ? data.capitalCityKey
    : (map?.nations.find((nation) => nation.id === nationId)?.capitalCityKey ?? null);
  const cityName = new Map(data.cities.map((city) => [city.key, city.name]));
  type City = (typeof data.cities)[number];
  type General = (typeof data.generals)[number];
  // 도시별 배치 장수 (원작 세력 도시의 장수 목록). 위치는 같은 국가 장수만 온다.
  const stationed = new Map<number, DetailedNationGeneral[]>();
  for (const general of data.generals)
    if (isDetailedGeneral(general))
      stationed.set(general.cityKey, [...(stationed.get(general.cityKey) ?? []), general]);
  const stationedNames = (key: number) =>
    stationed
      .get(key)
      ?.map((g) => displayName(g.name))
      .join(', ');
  const member = isMemberNation(data);
  // 지역 이름은 world.map regionName(INT-26)에서 읽는다. 소속국 도시만 주민(city.get 상세 모양)이 온다.
  const regionName = new Map(map?.cities.map((city) => [city.key, city.regionName ?? null]) ?? []);
  const showRegion = data.cities.some((city) => regionName.get(city.key));
  const showPopulation = data.cities.some(isDetailedCity);
  const opened = openCity === null ? undefined : data.cities.find((c) => c.key === openCity);

  const cityColumns: Column<City>[] = [
    {
      key: 'name',
      label: '도시',
      sortValue: (c) => c.name,
      render: (c) =>
        onSelectCity ? (
          <button type="button" className={styles.cityButton} onClick={() => onSelectCity(c.key)}>
            {c.name}
          </button>
        ) : (
          <Link to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(c.key) }}>
            {c.name}
          </Link>
        ),
    },
    ...(showRegion
      ? [
          {
            key: 'region',
            label: '지역',
            // 지역 번호 순서(서버의 소속국 기본 순서)로 정렬한다.
            sortValue: (c: City) => ('region' in c && typeof c.region === 'number' ? c.region : null),
            render: (c: City) => regionName.get(c.key) ?? '—',
          },
        ]
      : []),
    {
      key: 'level',
      label: '규모',
      numeric: true,
      sortValue: (c) => c.level,
      render: (c) => cityLevelText(c.level),
    },
    ...(showPopulation
      ? [
          {
            key: 'population',
            label: '주민',
            numeric: true,
            sortValue: (c: City) => (isDetailedCity(c) ? c.population : null),
            render: (c: City) => (isDetailedCity(c) ? `${n(c.population)} / ${n(c.populationMax)}` : '—'),
          },
        ]
      : []),
    {
      key: 'generals',
      label: '장수',
      numeric: true,
      sortValue: (c) => (member ? (stationed.get(c.key)?.length ?? 0) : null),
      // 소속국은 누르면 그 도시 장수의 능력치·자금·병력과 (직책자는) 예턴을 표 아래에 펼친다.
      render: (c) => {
        if (!member) return '—';
        const count = stationed.get(c.key)?.length ?? 0;
        const open = openCity === c.key;
        return (
          <button
            type="button"
            className={styles.expand}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${c.name} 장수 ${count}명 ${open ? '접기' : '펼치기'}`}
            onClick={() => setOpenCity(open ? null : c.key)}
          >
            {n(count)}
            <span aria-hidden="true">{open ? ' ▲' : ' ▼'}</span>
          </button>
        );
      },
      title: (c) => (member ? stationedNames(c.key) : HIDDEN_NATION),
    },
    {
      key: 'state',
      label: '상태',
      sortValue: (c) => (c.supplied ? 1 : 0),
      render: (c) => (
        <span className={styles.tags}>
          {c.key === capitalKey ? <Tag tone="accent">수도</Tag> : null}
          {c.supplied ? null : <Tag tone="danger">보급 끊김</Tag>}
        </span>
      ),
    },
  ];

  const hidden = (g: General) => (isDetailedGeneral(g) ? undefined : HIDDEN_NATION);
  const num = (pick: (g: Extract<General, { leadership: number }>) => number | undefined) => ({
    numeric: true,
    sortValue: (g: General) => (isDetailedGeneral(g) ? (pick(g) ?? null) : null),
    render: (g: General) => (isDetailedGeneral(g) ? (pick(g)?.toLocaleString('ko-KR') ?? '—') : '—'),
    title: hidden,
  });
  const text = (pick: (g: Extract<General, { leadership: number }>) => string | null) => ({
    sortValue: (g: General) => (isDetailedGeneral(g) ? pick(g) : null),
    render: (g: General) => (isDetailedGeneral(g) ? pick(g) || '—' : '—'),
  });
  const generalColumns: Column<General>[] = [
    {
      key: 'name',
      label: '장수',
      sortValue: (g) => displayName(g.name),
      render: (g) => <GeneralNameCell general={g} injury={false} />,
    },
    {
      key: 'officer',
      label: '직책',
      sortValue: (g) => (isDetailedGeneral(g) ? g.officerLevel : null),
      render: (g) => (isDetailedGeneral(g) ? officerName(g.officerLevel, g.nationId !== null) : '—'),
    },
    {
      key: 'city',
      label: '위치',
      sortValue: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? String(g.cityKey)) : null),
      render: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? g.cityKey) : '—'),
    },
    { key: 'leadership', label: '통솔', ...num((g) => g.leadership) },
    { key: 'strength', label: '무력', ...num((g) => g.strength) },
    { key: 'intel', label: '지력', ...num((g) => g.intel) },
    ...(fiveStats
      ? [
          { key: 'politics', label: '정치', ...num((g) => g.politics) },
          { key: 'charm', label: '매력', ...num((g) => g.charm) },
        ]
      : []),
    // 부곡 월드는 병종이 부곡마다 달라 장수 병종 열을 두지 않는다.
    ...(campaign
      ? []
      : [
          {
            key: 'crewType',
            label: '병종',
            sortValue: (g: General) => (isDetailedGeneral(g) ? g.crewType : null),
            render: (g: General) => (isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).name : '—'),
            title: (g: General) => (isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).title : HIDDEN_NATION),
          },
        ]),
    { key: 'crew', label: campaign ? '지휘 병력' : '병력', ...num((g) => armyOf(g).troops) },
    { key: 'train', label: campaign ? '평균 훈련' : '훈련', ...num((g) => armyOf(g).train) },
    { key: 'atmos', label: campaign ? '평균 사기' : '사기', ...num((g) => armyOf(g).atmos) },
    {
      key: 'care',
      label: '관리',
      render: (g) => (isDetailedGeneral(g) ? <GeneralCare general={g} /> : null),
    },
  ];
  // 원작 세력 장수 표의 자금·연령·명성·계급·성격·특기 (INT-25). 한 표에 모두 두면 768px에서 넘치므로 따로 둔다.
  const recordColumns: Column<General>[] = [
    generalColumns[0]!,
    { key: 'gold', label: '금', ...num((g) => g.gold) },
    { key: 'rice', label: '쌀', ...num((g) => g.rice) },
    { key: 'age', label: '나이', ...num((g) => displayedAge(g, summary)) },
    {
      key: 'tenureYears',
      label: '임관',
      numeric: true,
      sortValue: (g) => g.tenureYears ?? null,
      render: (g) => (g.tenureYears === undefined ? '—' : `${n(g.tenureYears)}년`),
    },
    { key: 'experience', label: '경험', ...num((g) => g.experience) },
    { key: 'dedication', label: '공헌', ...num((g) => g.dedication) },
    { key: 'personality', label: '성격', ...text((g) => g.personality) },
    { key: 'special', label: '특기', ...text((g) => g.special) },
  ];

  return (
    <div className={styles.tables}>
      {member ? null : (
        <p className={styles.note} role="note">
          {HIDDEN_NATION}라 장수 수치와 국고는 보이지 않습니다.
        </p>
      )}
      <div id="cities">
        <DataTable
          caption={`소유 도시 ${data.cities.length}곳`}
          rows={data.cities}
          columns={cityColumns}
          rowKey={(c) => c.key}
          mobileDetails={['region', 'population']}
        />
        {member && opened ? (
          <StationedPanel
            id={panelId}
            worldId={worldId}
            city={opened}
            generals={stationed.get(opened.key) ?? []}
            crewTypes={crewTypes}
            campaign={campaign}
            fiveStats={fiveStats}
            inspection={inspection}
            names={names}
            summary={summary}
            onClose={() => setOpenCity(null)}
          />
        ) : null}
      </div>
      {member ? <NationTotalsGrid generals={data.generals} /> : null}
      <DataTable
        caption={`소속 장수 ${data.generals.length}명`}
        rows={data.generals}
        columns={generalColumns}
        rowKey={(g) => g.id}
        mobileDetails={[
          'officer',
          'city',
          'leadership',
          'strength',
          'intel',
          'politics',
          'charm',
          'crewType',
          'train',
          'atmos',
          'care',
        ]}
      />
      {member ? (
        <DataTable
          caption={`장수 자금·이력 ${data.generals.length}명`}
          rows={data.generals}
          columns={recordColumns}
          rowKey={(g) => g.id}
          mobileDetails={['age', 'tenureYears', 'experience', 'dedication', 'personality', 'special']}
        />
      ) : null}
    </div>
  );
}

type DetailedNationGeneral = Extract<NationGenerals[number], { leadership: number }>;
type CrewTypes = NonNullable<ReturnType<typeof useWorldRules>['data']>['unitSet']['crewTypes'];

// 다음 턴. 직책자는 감찰 자료의 서버 시각을 쓰고, 그 밖에는 장수의 nextTurnTick으로 센 게임 연월만 쓴다.
// 화면에서 시각을 지어내지 않는다 (턴 시각은 서버가 준 값만 보인다).
export function nextTurnText(
  general: { nextTurnTick: number },
  row: Pick<InspectionRow, 'nextTurnAt'> | undefined,
  summary: WorldSummary | undefined,
  now = new Date(),
): string {
  if (row?.nextTurnAt) return formatTime(new Date(row.nextTurnAt), now);
  return slotTimes(1, summary, general.nextTurnTick, null, now)[0]?.date ?? '—';
}

// 펼친 도시 한 곳의 장수 (원작 세력 도시의 암행부 연동, INT-25 p2-city-18).
// 능력치·금·쌀·병종·병력·훈련·사기·다음 턴은 nation.get 장수 행, 예턴 앞 5칸은 직책자만 받는 감찰 자료다.
export function StationedPanel({
  id,
  worldId,
  city,
  generals,
  crewTypes,
  campaign,
  fiveStats,
  inspection,
  names,
  summary,
  onClose,
}: {
  id: string;
  worldId: string;
  city: { key: number; name: string };
  generals: readonly DetailedNationGeneral[];
  crewTypes: CrewTypes | undefined;
  campaign: boolean;
  fiveStats: boolean;
  inspection: Map<number, InspectionRow> | null;
  names: ArgNames;
  summary: WorldSummary | undefined;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [city.key]);
  return (
    <section ref={ref} id={id} className={styles.stationed} aria-label={`${city.name} 장수`} data-city-key={city.key}>
      <div className={styles.stationedHead}>
        <h3 className={styles.stationedTitle}>
          {city.name} 장수 {n(generals.length)}명
        </h3>
        <button type="button" className={styles.toggle} onClick={onClose}>
          접기
        </button>
      </div>
      <CityBandLine worldId={worldId} cityKey={city.key} />
      {generals.length === 0 ? (
        <p className={styles.note}>이 도시에 있는 소속 장수가 없습니다.</p>
      ) : (
        <StationedTable
          caption={`${city.name} 배치 장수 ${generals.length}명`}
          generals={generals}
          crewTypes={crewTypes}
          campaign={campaign}
          fiveStats={fiveStats}
          inspection={inspection}
          names={names}
          summary={summary}
        />
      )}
      {inspection ? null : <p className={styles.hint}>{TURNS_OFFICER_ONLY}.</p>}
    </section>
  );
}

// 펼친 도시의 인구율과 개발 정도 구간. 소속국 도시는 city.get 상세가 온다.
function CityBandLine({ worldId, cityKey }: { worldId: string; cityKey: number }) {
  const city = useCity(worldId, cityKey).data;
  if (!city || !isDetailedCity(city)) return null;
  return (
    <p className={styles.bands} data-testid="stationed-bands">
      <span>인구율 {populationRate(city.population, city.populationMax)}</span>
      {cityBands(city).map((row) => (
        <BandText key={row.label} band={row.band} label={row.label} />
      ))}
    </p>
  );
}

export function StationedTable({
  caption,
  generals,
  crewTypes,
  campaign,
  fiveStats,
  inspection,
  names,
  summary,
  now,
}: {
  caption: string;
  generals: readonly DetailedNationGeneral[];
  crewTypes: CrewTypes | undefined;
  campaign: boolean;
  fiveStats: boolean;
  inspection: Map<number, InspectionRow> | null;
  names: ArgNames;
  summary: WorldSummary | undefined;
  now?: Date;
}) {
  type G = DetailedNationGeneral;
  const num = (pick: (g: G) => number) => ({
    numeric: true,
    sortValue: (g: G) => pick(g),
    render: (g: G) => n(pick(g)),
  });
  const statKeys = fiveStats
    ? (['leadership', 'strength', 'intel', 'politics', 'charm'] as const)
    : (['leadership', 'strength', 'intel'] as const);
  const columns: Column<G>[] = [
    {
      key: 'name',
      label: '장수',
      sortValue: (g) => displayName(g.name),
      // NPC 딱지는 장수 행의 isHuman으로 단다. 감찰 자료의 사람 여부도 함께 본다.
      render: (g) => (
        <GeneralNameCell general={g} npc={inspection?.get(g.id)?.isHuman === false} possessedNpc={g.possessedNpc} />
      ),
    },
    {
      key: 'officer',
      label: '직책',
      sortValue: (g) => g.officerLevel,
      render: (g) => officerName(g.officerLevel, g.nationId !== null),
    },
    {
      key: 'stats',
      label: fiveStats ? '통·무·지·정·매' : '통·무·지',
      numeric: true,
      sortValue: (g) => g.leadership,
      render: (g) => statKeys.map((key) => g[key] ?? '—').join(' / '),
      title: () => (fiveStats ? '통솔 / 무력 / 지력 / 정치 / 매력' : '통솔 / 무력 / 지력'),
    },
    { key: 'gold', label: '금', ...num((g) => g.gold) },
    { key: 'rice', label: '쌀', ...num((g) => g.rice) },
    ...(campaign
      ? []
      : [
          {
            key: 'crewType',
            label: '병종',
            sortValue: (g: G) => g.crewType,
            render: (g: G) => unitNameOf(crewTypes, g.crewType).name,
            title: (g: G) => unitNameOf(crewTypes, g.crewType).title,
          },
        ]),
    { key: 'crew', label: campaign ? '지휘 병력' : '병력', ...num((g) => armyOf(g).troops) },
    { key: 'train', label: campaign ? '평균 훈련' : '훈련', ...num((g) => armyOf(g).train) },
    { key: 'atmos', label: campaign ? '평균 사기' : '사기', ...num((g) => armyOf(g).atmos) },
    {
      key: 'next',
      label: '다음 턴',
      sortValue: (g) => g.nextTurnTick,
      render: (g) => nextTurnText(g, inspection?.get(g.id), summary, now),
    },
    ...(inspection
      ? [
          {
            key: 'turns',
            label: '예턴',
            render: (g: G) => {
              const row = inspection.get(g.id);
              return row ? <TurnFive turns={row.turns} names={names} /> : '—';
            },
          },
        ]
      : []),
  ];
  return (
    <DataTable
      caption={caption}
      rows={generals}
      columns={columns}
      rowKey={(g) => g.id}
      mobileDetails={['officer', 'stats', 'gold', 'rice', 'crewType', 'train', 'atmos', 'next', 'turns']}
    />
  );
}

// 관리 필요 표시 (myosam 아이디어). 부상, 병력이 있는데 훈련·사기가 낮은 경우를 노랑으로 표시한다.
export function careTags(general: ArmyFields & { injury: number }): string[] {
  const tags: string[] = [];
  if (general.injury > 0) tags.push(`부상 ${general.injury}`);
  const army = armyOf(general);
  if (army.troops > 0 && army.train < 50) tags.push('훈련 부족');
  if (army.troops > 0 && army.atmos < 50) tags.push('사기 부족');
  return tags;
}

function GeneralCare({ general }: { general: ArmyFields & { injury: number } }) {
  const tags = careTags(general);
  return (
    <span className={styles.tags}>
      {tags.map((tag) => (
        <Tag key={tag} tone="warning">
          {tag}
        </Tag>
      ))}
    </span>
  );
}
