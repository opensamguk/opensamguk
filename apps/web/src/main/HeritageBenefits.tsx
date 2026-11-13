import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
      {pending ? <p role="status">구매 처리 중</p> : null}
      {mutation.isError || data.latest?.status === 'REJECTED' ? (
        <p role="alert">{mutation.isError ? serverMessage(mutation.error) : data.latest?.message}</p>
      ) : null}
    </details>
  );
}
