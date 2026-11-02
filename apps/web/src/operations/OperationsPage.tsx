import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import operationsIcon from '../art/icons/operations.png';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap, useWorldSummary } from '../game/queries';
import { serverMessage } from '../turns/apiError';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import type { CreateInput, OperationRow } from './contract';
import styles from './Operations.module.css';

// 국가 작전 목록과 만들기 (T2-12, AC-M2-15). 목록은 서버가 정한 순서(OPEN 먼저, 목표 tick 이른 순) 그대로 둔다.
export function OperationsPage() {
  const worldId = useWorldId();
  const trpc = useTRPC();
  const home = useHome(worldId);
  const list = useQuery({
    ...trpc.operation.list.queryOptions({ worldId }),
    refetchInterval: 15_000,
    retry: retryUnlessClientError,
  });

  let body;
  if (home.isError && errorCode(home.error) === 'NOT_FOUND') body = <NoGeneral worldId={worldId} />;
  else if (home.data && home.data.nation === null)
    body = <EmptyState title="소속 국가가 없습니다">작전은 국가에 속한 장수가 봅니다.</EmptyState>;
  else if (!list.data)
    body = list.isError ? (
      <QueryError error={list.error} notFound="작전을 찾을 수 없습니다" onRetry={() => void list.refetch()} />
    ) : (
      <LoadingState />
    );
  else
    body = (
      <>
        {home.data?.nation ? <p className={styles.plaque}>{`${home.data.nation.name}의 작전`}</p> : null}
        <OperationTable worldId={worldId} items={list.data.items} />
        {list.data.canCreate.ok && home.data?.nation ? (
          <CreateForm worldId={worldId} nationId={home.data.nation.id} />
        ) : !list.data.canCreate.ok && list.data.canCreate.code !== 'NO_PERMISSION' ? (
          <p className={styles.muted}>{list.data.canCreate.reason}</p>
        ) : null}
      </>
    );

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <img className="pixel-art" src={operationsIcon} alt="" width={48} height={48} />
        <h1>작전</h1>
      </div>
      {body}
    </section>
  );
}

function OperationTable({ worldId, items }: { worldId: string; items: OperationRow[] }) {
  if (items.length === 0) return <EmptyState title="볼 수 있는 작전이 없습니다" />;
  return (
    <table className={styles.table} data-testid="operation-list">
      <thead>
        <tr>
          <th scope="col">목표 도시</th>
          <th scope="col">목표 연월</th>
          <th scope="col">상태</th>
          <th scope="col" className="num">
            준비 / 참여
          </th>
          <th scope="col">만든 장수</th>
          <th scope="col">내 참여</th>
        </tr>
      </thead>
      <tbody>
        {items.map((op) => (
          <tr key={op.id}>
            <td>
              <Link to="/w/$worldId/operations/$operationId" params={{ worldId, operationId: op.id }}>
                {op.target.cityName}
              </Link>{' '}
              {op.target.nation ? (
                <NationBadge name={op.target.nation.name} color={op.target.nation.color} />
              ) : (
                <NationBadge name="공백지" color={null} />
              )}
            </td>
            <td>{formatYearMonth(op.targetDate)}</td>
            <td>{op.status === 'OPEN' ? <Tag tone="accent">진행</Tag> : <Tag tone="muted">닫힘</Tag>}</td>
            <td className="num">
              {op.ready} / {op.members}
            </td>
            <td>{op.createdBy.name}</td>
            <td>{op.joined ? '참여' : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const toInt = (raw: string) => (raw.trim() !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null);

// 작전 만들기. 화면 검사는 형식만 돕고 판단은 서버가 한다(지난 연월 등, 사용자 결정 U62-4b).
function CreateForm({ worldId, nationId }: { worldId: string; nationId: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const map = useWorldMap(worldId);
  const summary = useWorldSummary(worldId);
  const nation = useQuery({
    ...trpc.nation.get.queryOptions({ worldId, nationId }),
    retry: retryUnlessClientError,
  });
  const now = summary.data?.gameDate;
  const [cityKey, setCityKey] = useState('');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [min, setMin] = useState({ crew: '3000', train: '80', atmos: '80' });
  const [members, setMembers] = useState<Set<number>>(() => new Set());

  const cities = useMemo(
    () =>
      [...(map.data?.cities ?? [])]
        .filter((c) => c.nationId !== nationId)
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [map.data, nationId],
  );
  const generals = nation.data?.generals ?? [];

  // 만들기는 작전 메타데이터만 저장한다. 작전 경로만 다시 받고 예턴 캐시는 건드리지 않는다.
  const create = useMutation(
    trpc.operation.create.mutationOptions({
      onSuccess: ({ id }) => {
        void queryClient.invalidateQueries({ queryKey: trpc.operation.pathKey() });
        void navigate({ to: '/w/$worldId/operations/$operationId', params: { worldId, operationId: id } });
      },
    }),
  );

  const input: CreateInput | null = (() => {
    const target = toInt(cityKey);
    const y = toInt(year || String(now?.year ?? ''));
    const m = toInt(month || String(now?.month ?? ''));
    const crew = toInt(min.crew);
    const train = toInt(min.train);
    const atmos = toInt(min.atmos);
    if (target === null || y === null || m === null || crew === null || train === null || atmos === null) return null;
    if (m < 1 || m > 12 || members.size === 0) return null;
    return {
      targetCityKey: target,
      targetYear: y,
      targetMonth: m,
      min: { crew, train, atmos },
      memberIds: [...members],
    };
  })();
  const blocked = create.isPending
    ? '만드는 중입니다.'
    : input === null
      ? '목표 도시, 목표 연월(월은 1~12), 기준 병력·훈련·사기, 참여 장수를 모두 채우세요.'
      : null;

  return (
    <form
      className={styles.create}
      aria-label="작전 만들기"
      onSubmit={(e) => {
        e.preventDefault();
        if (input) create.mutate({ worldId, ...input });
      }}
    >
      <h2>작전 만들기</h2>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>목표 도시</span>
          <select value={cityKey} onChange={(e) => setCityKey(e.target.value)}>
            <option value="">고르세요</option>
            {cities.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>목표 연</span>
          <input
            type="number"
            className="num"
            value={year}
            placeholder={now ? String(now.year) : ''}
            onChange={(e) => setYear(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>목표 월</span>
          <input
            type="number"
            className="num"
            min={1}
            max={12}
            value={month}
            placeholder={now ? String(now.month) : ''}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        {(['crew', 'train', 'atmos'] as const).map((key) => (
          <label key={key} className={styles.field}>
            <span>{key === 'crew' ? '기준 병력' : key === 'train' ? '기준 훈련' : '기준 사기'}</span>
            <input
              type="number"
              className="num"
              min={0}
              value={min[key]}
              onChange={(e) => setMin((prev) => ({ ...prev, [key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <fieldset className={styles.members}>
        <legend>참여 장수 ({members.size}명)</legend>
        {nation.isError ? <p className={styles.warn}>소속 장수를 불러오지 못했습니다.</p> : null}
        {generals.map((g) => (
          <label key={g.id} className={styles.member}>
            <input
              type="checkbox"
              checked={members.has(g.id)}
              onChange={(e) =>
                setMembers((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(g.id);
                  else next.delete(g.id);
                  return next;
                })
              }
            />
            {g.name}
          </label>
        ))}
      </fieldset>
      {create.isError ? (
        <p role="alert" className={styles.warn}>
          {serverMessage(create.error) ?? '만들지 못했습니다. 연결을 확인하고 다시 누르세요.'}
        </p>
      ) : null}
      <div className={styles.buttons}>
        {blocked === null ? (
          <button type="submit" className={styles.primary}>
            작전 만들기
          </button>
        ) : (
          <DisabledReason reason={blocked}>작전 만들기</DisabledReason>
        )}
      </div>
    </form>
  );
}
