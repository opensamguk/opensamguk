import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useEquipment } from '../equipment/useEquipment';
import { errorCode } from '../game/errors';
import { NoGeneral, QueryError } from '../game/QueryState';
import type { Home } from '../game/types';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { GovernancePanel } from '../governance/GovernancePanel';
import { LineagePanel } from '../lineage/LineagePanel';
import { GeneralInfo } from '../main/GeneralInfo';
import { Panel } from '../main/Panel';
import { CampaignPanel } from '../personnel/CampaignPanel';
import { RetinueOrdersPanel } from '../personnel/RetinueOrdersPanel';
import { useTRPC } from '../trpc';
import { EmptyState, LoadingState } from '../ui/States';
import styles from './WorldPages.module.css';

// 메인에서 옮겨 온 전용 화면 (INT-25, D-085). 원작처럼 위에 군략도로 단추와 제목을 두고 화면 하나에 일 하나를 둔다.
export function SubPage({ title, children }: { title: string; children: ReactNode }) {
  const worldId = useWorldId();
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>{title}</h1>
        <Link to="/w/$worldId" params={{ worldId }} className={styles.back}>
          군략도로
        </Link>
      </header>
      {children}
    </section>
  );
}

// /w/:worldId/campaign: 개인 휘하·부곡과 장수 지시.
export function CampaignPage() {
  const worldId = useWorldId();
  const trpc = useTRPC();
  const mine = useQuery(trpc.general.mine.queryOptions({ worldId }));
  const enabled = mine.data?.creationRules.campaignEnabled === true;
  return (
    <SubPage title="휘하·부곡">
      {mine.isPending ? (
        <LoadingState />
      ) : !mine.data?.general ? (
        <NoGeneral worldId={worldId} />
      ) : enabled ? (
        <>
          <CampaignPanel worldId={worldId} />
          <RetinueOrdersPanel worldId={worldId} />
        </>
      ) : (
        <EmptyState title="이 월드는 휘하·부곡을 쓰지 않습니다" />
      )}
    </SubPage>
  );
}

// /w/:worldId/nation/governance: 황실·정통성·직위·봉신.
export function GovernancePage() {
  const worldId = useWorldId();
  return (
    <SubPage title="통치">
      <GovernancePanel worldId={worldId} />
    </SubPage>
  );
}

// /w/:worldId/me: 내 장수 상세. 초상 portrait·장비와 가문을 함께 본다.
export function MePage() {
  const worldId = useWorldId();
  const home = useHome(worldId, true);
  const map = useWorldMap(worldId);
  const summary = useWorldSummary(worldId);
  const trpc = useTRPC();
  const mine = useQuery(trpc.general.mine.queryOptions({ worldId }));
  const equipment = useEquipment(worldId, summary.data?.equipmentEnabled === true, home.data?.general.id);
  const noGeneral = home.isError && errorCode(home.error) === 'NOT_FOUND';
  const data = home.data;
  const cityName = (key: number) => map.data?.cities.find((city) => city.key === key)?.name ?? String(key);
  return (
    <SubPage title="내 정보">
      {noGeneral ? (
        <NoGeneral worldId={worldId} />
      ) : home.isError ? (
        <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <>
          <Panel title="장수">
            <GeneralInfo
              worldId={worldId}
              home={data}
              campaignEnabled={mine.data?.creationRules.campaignEnabled ?? false}
              cityName={cityName(data.general.cityKey)}
              nation={
                data.general.nationId === null
                  ? undefined
                  : map.data?.nations.find((nation) => nation.id === data.general.nationId)
              }
              onSelectCity={() => undefined}
              equipment={equipment}
            />
            {data.general.defense.stance?.editable ? (
              <DefenseStance worldId={worldId} defense={data.general.defense} />
            ) : null}
          </Panel>
          <div id="lineage">
            <LineagePanel worldId={worldId} />
          </div>
        </>
      )}
    </SubPage>
  );
}

function DefenseStance({ worldId, defense }: { worldId: string; defense: Home['general']['defense'] }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [choice, setChoice] = useState<NonNullable<Home['general']['defense']['stance']>['options'][number]>();
  const save = useMutation(
    trpc.general.setDefenseStance.mutationOptions({
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
        setChoice(undefined);
      },
    }),
  );
  const options = defense.stance?.options ?? [];
  const pending = defense.stance?.pendingThreshold;
  const active = defense.stance?.enabled ? defense.minimumTraining : 999;
  const selected = choice ?? pending ?? active;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (choice !== undefined && choice !== active && pending == null) save.mutate({ worldId, threshold: choice });
      }}
    >
      <label>
        수비 기준{' '}
        <select
          value={selected}
          disabled={save.isPending || pending != null}
          onChange={(event) => {
            const value = options.find((threshold) => threshold === Number(event.target.value));
            if (value !== undefined) setChoice(value);
          }}
        >
          {options.map((threshold) => (
            <option key={threshold} value={threshold}>
              {threshold === 999 ? '수비 안 함' : `훈련·사기 ${threshold} 이상`}
            </option>
          ))}
        </select>
      </label>{' '}
      <button type="submit" disabled={choice === undefined || choice === active || save.isPending || pending != null}>
        저장
      </button>
      {pending != null ? <p role="status">수비 기준 변경을 처리하고 있습니다.</p> : null}
      {save.isError ? <p role="alert">{save.error.message}</p> : null}
    </form>
  );
}
