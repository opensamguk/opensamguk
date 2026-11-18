// 전체 지도에서 보는 내 예턴(D-106). 넣기와 고치기는 성 화면에서만 하고, 여기서는 저장된 칸을 보기만 한다.
// inline은 아래 띠에 앞 다섯 칸만 한 줄로, 아니면 판에 서른 칸 목록과 성 화면으로 돌아가는 단추를 보인다.
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import styles from './TurnPeek.module.css';

export function TurnPeek({
  worldId,
  inline = false,
  onBack,
  backLabel,
}: {
  worldId: string;
  inline?: boolean;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
}) {
  const trpc = useTRPC();
  const turns = useQuery(trpc.turns.get.queryOptions({ worldId }));
  const slots = turns.data?.slots ?? [];
  // 빈 칸은 서버가 이름을 비워 둔다. 기본 방침 문구는 성 화면의 편집기가 보인다.
  const label = (slot: (typeof slots)[number] | null | undefined) => (slot?.commandKey ? slot.name : '빈 칸');
  if (inline)
    return (
      <span className={styles.inline} aria-label="내 예턴 앞 다섯 칸">
        <b>내 예턴</b>
        {turns.isPending
          ? '불러오는 중'
          : slots.slice(0, 5).map((slot, index) => (
              <span key={index} data-empty={!slot?.commandKey || undefined}>
                {index + 1} {label(slot)}
              </span>
            ))}
      </span>
    );
  return (
    <section className={styles.list} aria-label="내 예턴">
      {onBack ? (
        <button type="button" className="kit-button" data-kind="accent" onClick={onBack}>
          {backLabel ?? '성으로 돌아가기'}
        </button>
      ) : null}
      <ol>
        {slots.map((slot, index) => (
          <li key={index} className="kit-row" data-empty={!slot?.commandKey || undefined}>
            <b>{index + 1}</b> {label(slot)}
          </li>
        ))}
      </ol>
    </section>
  );
}
