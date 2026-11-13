import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { displayName } from '../game/names';
import { useWorldId } from '../game/queries';
import { useTRPC } from '../trpc';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import type { CommandInfo, GeneralChoice } from '../turns/CommandPicker';
import { formatTime } from '../turns/schedule';
import type { Check, TurnList, TurnSourceFactory } from '../turns/source';
import { TurnEditor } from '../turns/TurnEditor';
import { LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import {
  personnelKeys,
  usePersonnelApi,
  type NationTurnTab,
  type Office,
  type PersonnelApi,
  type PersonnelBoard,
} from './contract';
import styles from './Personnel.module.css';
import { LoadError, NationNav } from './PersonnelPage';

export const NATION_SLOT_COUNT = 12;

const NATION_DRAFT_PREFIX = 'opensamguk.nationTurnDraft.v1';

// 초안 키에 계정·월드와 본 직책(국가·직책·tenure)을 넣는다. 직책이나 tenure가 바뀌면 예전 초안을 새 칸에 불러오지 않는다.
export const nationDraftKey = (userId: string, worldId: string, office: Office) =>
  `${NATION_DRAFT_PREFIX}:${userId}:${worldId}:${office.nationId}:${office.officerLevel}:${office.tenure}`;

type TabsData = { actorId: number; tabs: NationTurnTab[] };
// 국가 칸은 임시 계약(PersonnelApi)의 칸 모양 그대로 캐시와 저장 결과에 쓴다. 개인 칸 모양과 섞지 않는다.
type NationSlot = NationTurnTab['slots'][number];
type NationCommandRow = inferRouterOutputs<AppRouter>['nationCommands']['list'][number];

// 국가 직책 12칸 연결. 저장은 읽은 탭의 office와 revision을 그대로 돌려보낸다 (T2-05 국가 예턴 절).
export function nationSource(
  api: PersonnelApi,
  tab: NationTurnTab,
  options: {
    generals?: GeneralChoice[] | undefined;
    onOfficeChanged: (message: string) => void;
    // 칸 주인의 다음 턴 시각(감찰 조회). 남의 직책 칸의 실행 시기를 센다. 모르면 undefined.
    holderNextTurnAt?: string | null | undefined;
  },
): TurnSourceFactory<NationSlot> {
  const level = tab.officerLevel;
  const office = tab.office;
  return ({ userId, worldId }) => {
    const listKey = personnelKeys.nationTurns(worldId);
    return {
      slotCount: NATION_SLOT_COUNT,
      storageKey: nationDraftKey(userId, worldId, office),
      gridLabel: `${tab.title} 국가 예턴 ${NATION_SLOT_COUNT}칸`,
      list: {
        queryKey: listKey,
        queryFn: () => api.nationTurns({ worldId }),
        select: (data) => {
          const found = (data as TabsData).tabs.find((t) => t.officerLevel === level);
          return { actorId: (data as TabsData).actorId, revision: found?.revision ?? 0, slots: found?.slots ?? [] };
        },
      },
      writeList: (queryClient: QueryClient, list: TurnList<NationSlot>) =>
        queryClient.setQueryData<TabsData>(listKey, (old) =>
          old
            ? {
                ...old,
                tabs: old.tabs.map((t) =>
                  t.officerLevel === level ? { ...t, revision: list.revision, slots: list.slots } : t,
                ),
              }
            : old,
        ),
      save: ({ revision, slots, expectedActorId }) =>
        api.setNationTurns({
          worldId,
          office,
          revision,
          slots,
          expectedUserId: userId,
          ...(expectedActorId === undefined ? {} : { expectedActorId }),
        }),
      commands: {
        queryKey: personnelKeys.nationCommands(worldId),
        queryFn: () => api.nationCommands({ worldId }),
        // 서버가 실은 실행 가능 여부·사유(available·reason, INT-26)를 그대로 넘겨 명령 카드가 흐림과 사유를 그린다.
        select: (data): CommandInfo[] =>
          (data as NationCommandRow[]).map((c) => ({
            ...c,
            category: 'nation',
          })),
      },
      precheck: (turn) => ({
        queryKey: personnelKeys.precheck(worldId, turn.commandKey, turn.args),
        queryFn: () => api.precheckNation({ worldId, commandKey: turn.commandKey, args: turn.args }),
        select: (data): Check => {
          const allowed = data as { ok: true } | { ok: false; reason: string };
          return allowed.ok ? { ok: true } : { ok: false, message: allowed.reason };
        },
      }),
      precheckRoot: personnelKeys.precheckRoot,
      timed: tab.edit.ok,
      nextTurnAt: tab.edit.ok ? undefined : options.holderNextTurnAt,
      readOnly: tab.edit.ok ? null : tab.edit.reason,
      generals: options.generals,
      walletKind: 'nation',
      onOfficeChanged: options.onOfficeChanged,
    };
  };
}

// /w/:worldId/nation/turns. 직책 탭(군주·참모·수뇌)마다 12칸. 내 직책 칸만 편집하고 남의 칸은 읽기 전용이다 (T2-06).
export function NationTurnsPage() {
  const worldId = useWorldId();
  const api = usePersonnelApi();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tabs = useQuery({
    queryKey: personnelKeys.nationTurns(worldId),
    queryFn: () => api.nationTurns({ worldId }),
    retry: false,
  });
  // 포상·몰수·발령의 대상 장수를 이름으로 고른다. 못 받으면 번호로 넣는다.
  const board = useQuery({
    queryKey: personnelKeys.officers(worldId),
    queryFn: () => api.officers({ worldId }),
    retry: false,
  });
  // 직책자마다 다음 턴 시각. 감찰과 같은 조회이며 직책자(수뇌 이상)만 받는다. 못 받으면 남의 칸 시각을 비워 둔다.
  const inspection = useQuery({
    ...trpc.inspection.members.queryOptions({ worldId }),
    refetchInterval: (query) => (query.state.error ? false : 60_000),
    retry: retryUnlessClientError,
  });
  const nextTurnAt = useMemo(
    () => new Map(inspection.data?.items.map((row) => [row.generalId, row.nextTurnAt]) ?? []),
    [inspection.data],
  );
  const isHuman = useMemo(() => new Map(board.data?.members.map((m) => [m.generalId, m.isHuman]) ?? []), [board.data]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [officeNotice, setOfficeNotice] = useState<string | null>(null);

  // 서버가 직책이 바뀌었다고 거부했다. 그 문구를 보이고 국가 예턴을 다시 받는다.
  const onOfficeChanged = useCallback(
    (message: string) => {
      setOfficeNotice(message);
      void queryClient.invalidateQueries({ queryKey: personnelKeys.nationTurns(worldId) });
      void queryClient.invalidateQueries({ queryKey: personnelKeys.officers(worldId) });
    },
    [queryClient, worldId],
  );

  const list = tabs.data?.tabs ?? [];
  const tab = list.find((t) => t.officerLevel === chosen) ?? list.find((t) => t.edit.ok) ?? list[0];
  const generals = useMemo(() => membersOf(board.data), [board.data]);
  const holderNextTurnAt = tab?.holder ? nextTurnAt.get(tab.holder.generalId) : undefined;
  const source = useMemo(
    () => (tab ? nationSource(api, tab, { generals, onOfficeChanged, holderNextTurnAt }) : null),
    // 조회 결과가 같으면 TanStack Query가 같은 객체를 돌려주므로 칸이 실제로 바뀔 때만 새로 만든다.
    // 편집기는 storageKey(본 직책)가 같으면 다시 만들지 않으므로 초안은 그대로다.
    [api, tab, generals, onOfficeChanged, holderNextTurnAt],
  );
  const now = new Date();

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>국가 예턴</h1>
        <NationNav worldId={worldId} current="turns" />
      </header>
      {officeNotice ? (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert" data-testid="office-changed">
          {officeNotice}
        </p>
      ) : null}
      {tabs.isError ? (
        <LoadError error={tabs.error} onRetry={() => void tabs.refetch()} />
      ) : !tabs.data ? (
        <LoadingState />
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="직책">
            {list.map((t) => (
              <button
                key={t.officerLevel}
                type="button"
                role="tab"
                className={styles.tab}
                aria-selected={t === tab}
                onClick={() => setChosen(t.officerLevel)}
              >
                {t.title} · {t.holder ? displayName(t.holder.name) : '빈 자리'}
                {/* 사람·NPC는 인사부 조회(personnel.officers)의 isHuman으로 가린다. 모르면 붙이지 않는다. */}
                {t.holder && isHuman.get(t.holder.generalId) === false ? (
                  <>
                    {' '}
                    <Tag tone="muted">NPC</Tag>
                  </>
                ) : null}
                {t.edit.ok ? <span className={styles.mine}>(내 칸)</span> : null}
                <TabNextTurn at={t.holder ? nextTurnAt.get(t.holder.generalId) : undefined} now={now} />
              </button>
            ))}
          </div>
          {tab && source ? (
            <div role="tabpanel" aria-label={`${tab.title} 칸`}>
              <TurnEditor worldId={worldId} selectedCityKey={null} source={source} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// 탭 단추의 다음 턴 시각. 서버가 시각을 주지 않았거나(멈춘 월드·가속) 모르면 적지 않는다.
function TabNextTurn({ at, now }: { at: string | null | undefined; now: Date }) {
  if (!at) return null;
  return (
    <span className={styles.tabTime}>
      다음 턴 <time dateTime={at}>{formatTime(new Date(at), now)}</time>
    </span>
  );
}

// 인자 입력 화면의 대상 장수 후보. 소재 도시와 유저 여부도 넘겨 `이름 (도시)`와 NPC 표시에 쓴다 (INT-25).
function membersOf(board: PersonnelBoard | undefined): GeneralChoice[] | undefined {
  return board?.members.map((m) => ({ id: m.generalId, name: m.name, cityName: m.city.name, isHuman: m.isHuman }));
}
