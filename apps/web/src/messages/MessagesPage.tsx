import { Link } from '@tanstack/react-router';
import { useHome, useWorldId, useWorldEnded } from '../game/queries';
import pageStyles from '../pages/WorldPages.module.css';
import { MessagePanel } from './MessagePanel';
import { NationBoard } from './NationBoard';

// /w/:worldId/messages: 메시지를 넓게 본다. 메인 오른쪽 패널과 같은 부품이라 탭과 작성 중인 글을 함께 쓴다.
export function MessagesPage() {
  const worldId = useWorldId();
  const general = useHome(worldId).data?.general;
  const ended = useWorldEnded(worldId);
  return (
    <section className={pageStyles.page}>
      <header className={pageStyles.header}>
        <h1>메시지</h1>
        <Link to="/w/$worldId" params={{ worldId }} className={pageStyles.back}>
          메인에서 보기
        </Link>
      </header>
      <MessagePanel worldId={worldId} />
      {general?.nationId != null ? (
        <NationBoard
          key={`${worldId}:${general.id}:${general.nationId}:${general.officerLevel}`}
          worldId={worldId}
          nationId={general.nationId}
          canWrite={!ended}
        />
      ) : null}
    </section>
  );
}
