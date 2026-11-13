import { useQuery } from '@tanstack/react-query';
import { retryUnlessClientError } from '../game/errors';
import { displayName } from '../game/names';
import { useWorldMap } from '../game/queries';
import { Portrait } from '../portrait/Portrait';
import { useTRPC } from '../trpc';
import styles from './RelationList.module.css';

const kindNames = { kin: '혈연', sworn: '결의', lord: '군신' };

// 장수 정보의 인물 관계 (AC-P2-20). relations.list는 이름만 주므로 얼굴은 같은 화면이 이미 받은 world.map 장수 목록에서
// 번호로 찾는다. 안개로 지도 목록에 없는 인물은 실루엣이다.
export function RelationList({ worldId, generalId }: { worldId: string; generalId: number }) {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.relations.list.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: 30_000,
  });
  const map = useWorldMap(worldId);
  const relations = data?.items.flatMap(({ a, b, kind }) => {
    const other = a.id === generalId ? b : b.id === generalId ? a : undefined;
    return other ? [{ other, kind }] : [];
  });
  if (!relations?.length) return null;
  const portraits = new Map((map.data?.generals ?? []).map((general) => [general.id, general.portraitId]));
  return (
    <section aria-label="인물 관계">
      <h3>인물 관계</h3>
      <ul className={styles.list}>
        {relations.map(({ other, kind }) => (
          <li key={other.id} className={styles.row}>
            <Portrait
              id={portraits.get(other.id) ?? null}
              name={displayName(other.name)}
              variant="icon"
              shape="round"
              size={24}
              decorative
            />
            <span>
              {displayName(other.name)} · {kindNames[kind]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
