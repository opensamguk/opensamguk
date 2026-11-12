import { useQuery } from '@tanstack/react-query';
import { retryUnlessClientError } from '../game/errors';
import { useTRPC } from '../trpc';

const kindNames = { kin: '혈연', sworn: '결의', lord: '군신' };

export function RelationList({ worldId, generalId }: { worldId: string; generalId: number }) {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.relations.list.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: 30_000,
  });
  const relations = data?.items.flatMap(({ a, b, kind }) => {
    const other = a.id === generalId ? b : b.id === generalId ? a : undefined;
    return other ? [{ other, kind }] : [];
  });
  if (!relations?.length) return null;
  return (
    <section aria-label="인물 관계">
      <h3>인물 관계</h3>
      <ul>
        {relations.map(({ other, kind }) => (
          <li key={other.id}>
            {other.name} · {kindNames[kind]}
          </li>
        ))}
      </ul>
    </section>
  );
}
