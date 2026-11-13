import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import { retryUnlessClientError } from '../game/errors';

type Benefits = Extract<inferRouterOutputs<AppRouter>['heritage']['benefits'], { enabled: true }>;
type Benefit = Benefits['options'][number];

export function HeritageBenefits({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.heritage.benefits.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: (query) =>
      query.state.data?.enabled && query.state.data.latest?.status === 'PENDING' ? 1000 : false,
  });
  if (!query.data?.enabled) return null;
  return <PurchaseForm key={query.data.generalId} worldId={worldId} data={query.data} refresh={query.refetch} />;
}

function PurchaseForm({
  worldId,
  data,
  refresh,
}: {
  worldId: string;
  data: Benefits;
  refresh: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const mutation = useMutation(trpc.heritage.purchase.mutationOptions());
  const [selected, setSelected] = useState<Benefit['benefit'] | ''>('');
  const [level, setLevel] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const option = data.options.find(({ benefit }) => benefit === selected);
  const cost = option && level > option.level ? (data.costs[level] ?? 0) - (data.costs[option.level] ?? 0) : 0;
  const pending = mutation.isPending || data.latest?.status === 'PENDING';
  return (
    <details>
      <summary>유산 혜택</summary>
      <p>보유 {data.balance}점 · 단계마다 확률 1%p 보정</p>
      <ul>
        {data.options.map(({ benefit, label, level }) => (
          <li key={benefit}>
            {label} · {level}단계
          </li>
        ))}
      </ul>
      {data.canPurchase ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!option || !cost || cost > data.balance || pending) return;
            if (!confirm) {
              setConfirm(true);
              return;
            }
            mutation.mutate(
              { worldId, benefit: option.benefit, level, expectedGeneralId: data.generalId, expectedCost: cost },
              {
                onSuccess: async () => {
                  await refresh();
                  setConfirm(false);
                  setLevel(0);
                },
              },
            );
          }}
        >
          <label>
            혜택
            <select
              disabled={pending}
              value={selected}
              onChange={(event) => {
                const next = data.options.find(({ benefit }) => benefit === event.currentTarget.value);
                setSelected(next?.benefit ?? '');
                setLevel(0);
                setConfirm(false);
              }}
            >
              <option value="">선택</option>
              {data.options
                .filter(({ level }) => level < 5)
                .map(({ benefit, label }) => (
                  <option key={benefit} value={benefit}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            구매 단계
            <select
              disabled={!option || pending}
              value={level}
              onChange={(event) => {
                setLevel(Number(event.currentTarget.value));
                setConfirm(false);
              }}
            >
              <option value={0}>선택</option>
              {option
                ? data.costs.map((total, index) =>
                    index > option.level ? (
                      <option key={index} value={index}>
                        {index}단계 · {total - (data.costs[option.level] ?? 0)}점
                      </option>
                    ) : null,
                  )
                : null}
            </select>
          </label>
          {confirm && option ? (
            <p role="status">
              {option.label} {level}단계에 {cost}점을 사용합니다.
            </p>
          ) : null}
          <button type="submit" disabled={!cost || cost > data.balance || pending}>
            {confirm ? '구매 확정' : '구매 확인'}
          </button>
          {confirm ? (
            <button type="button" onClick={() => setConfirm(false)} disabled={pending}>
              취소
            </button>
          ) : null}
        </form>
      ) : null}
      {data.turnTime ? <TurnTimePurchase worldId={worldId} data={data} pending={pending} refresh={refresh} /> : null}
      {data.specialty ? <SpecialtyPurchase worldId={worldId} data={data} pending={pending} refresh={refresh} /> : null}
      {pending ? <p role="status">구매 처리 중</p> : null}
      {mutation.isError || data.latest?.status === 'REJECTED' ? (
        <p role="alert">{mutation.isError ? serverMessage(mutation.error) : data.latest?.message}</p>
      ) : null}
    </details>
  );
}

function TurnTimePurchase({
  worldId,
  data,
  pending,
  refresh,
}: {
  worldId: string;
  data: Benefits;
  pending: boolean;
  refresh: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const [confirm, setConfirm] = useState(false);
  const requestId = useRef<string | null>(null);
  const mutation = useMutation(trpc.heritage.turnTime.mutationOptions());
  const timing = data.turnTime!;
  const busy = pending || mutation.isPending;
  const cost = timing.cost;
  const date = timing.pendingAt ? new Date(timing.pendingAt).toLocaleString('ko-KR') : null;
  return (
    <div>
      <h3>랜덤 턴 시간 초기화</h3>
      {timing.pendingTick !== null ? (
        <p>다다음 턴부터 적용{date ? ` · ${date}` : ''}</p>
      ) : data.canPurchase && cost !== null ? (
        <>
          {confirm ? <p role="status">{cost}점을 사용합니다. 이번에 예약된 다음 턴 시각은 유지됩니다.</p> : null}
          <button
            type="button"
            disabled={busy || cost > data.balance}
            onClick={() => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              requestId.current ??= crypto.randomUUID();
              mutation.mutate(
                { worldId, requestId: requestId.current, expectedGeneralId: data.generalId, expectedCost: cost },
                {
                  onSuccess: async () => {
                    await refresh();
                    setConfirm(false);
                    requestId.current = null;
                  },
                },
              );
            }}
          >
            {confirm ? '초기화 확정' : `초기화 확인 · ${cost}점`}
          </button>
          {confirm ? (
            <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
              취소
            </button>
          ) : null}
        </>
      ) : null}
      {mutation.isError ? <p role="alert">{serverMessage(mutation.error)}</p> : null}
    </div>
  );
}

function SpecialtyPurchase({
  worldId,
  data,
  pending,
  refresh,
}: {
  worldId: string;
  data: Benefits;
  pending: boolean;
  refresh: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const [selected, setSelected] = useState('');
  const [confirm, setConfirm] = useState<'reserve' | 'reset' | null>(null);
  const requestId = useRef<string | null>(null);
  const mutation = useMutation(trpc.heritage.specialty.mutationOptions());
  const specialty = data.specialty!;
  const option = specialty.options.find(({ name }) => name === selected);
  const busy = pending || mutation.isPending;
  const cost = confirm === 'reserve' ? specialty.reserveCost : specialty.resetCost;
  return (
    <div>
      <h3>전투 특기</h3>
      <p>
        현재 {specialty.current ?? '없음'} · 예약 {specialty.next ?? '없음'}
      </p>
      {data.canPurchase ? (
        <>
          <label>
            다음 전투 특기
            <select
              disabled={busy || specialty.next !== null}
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setConfirm(null);
                requestId.current = null;
              }}
            >
              <option value="">선택</option>
              {specialty.options
                .filter(({ name }) => name !== specialty.current)
                .map(({ name }) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          {option ? <p>{option.description}</p> : null}
          <button
            type="button"
            disabled={busy || !option || !!specialty.next || specialty.reserveCost > data.balance}
            onClick={() => {
              setConfirm('reserve');
              requestId.current = null;
            }}
          >
            다음 특기 예약 · {specialty.reserveCost}점
          </button>
          {specialty.resetCost !== null ? (
            <button
              type="button"
              disabled={busy || specialty.resetCost > data.balance}
              onClick={() => {
                setConfirm('reset');
                requestId.current = null;
              }}
            >
              전투 특기 초기화 · {specialty.resetCost}점
            </button>
          ) : null}
          {confirm && cost ? (
            <div>
              <p role="status">
                {confirm === 'reserve' ? option?.name + ' 예약' : '전투 특기 초기화'}에 {cost}점을 사용합니다.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const action =
                    confirm === 'reset'
                      ? { action: 'reset' as const }
                      : { action: 'reserve' as const, specialty: selected };
                  requestId.current ??= crypto.randomUUID();
                  mutation.mutate(
                    {
                      worldId,
                      action,
                      requestId: requestId.current,
                      expectedGeneralId: data.generalId,
                      expectedCost: cost,
                    },
                    {
                      onSuccess: async () => {
                        await refresh();
                        setConfirm(null);
                        requestId.current = null;
                      },
                    },
                  );
                }}
              >
                구매 확정
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                취소
              </button>
            </div>
          ) : null}
          {mutation.isError ? <p role="alert">{serverMessage(mutation.error)}</p> : null}
        </>
      ) : null}
    </div>
  );
}
