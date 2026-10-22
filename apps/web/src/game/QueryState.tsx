import { Link } from '@tanstack/react-router';
import { EmptyState, ErrorState } from '../ui/States';
import { isNotFound } from './errors';

// 조회 실패를 같은 방식으로 보여 준다. 없는 대상(404·잘못된 주소)과 연결 실패를 나눈다.
export function QueryError({ error, notFound, onRetry }: { error: unknown; notFound: string; onRetry: () => void }) {
  if (isNotFound(error)) return <EmptyState title={notFound} />;
  return <ErrorState title="불러오지 못했습니다" onRetry={onRetry} />;
}

// 이 월드에 내 장수가 없을 때. 장수 생성 화면(T1-15)으로 안내한다.
export function NoGeneral({ worldId }: { worldId: string }) {
  return (
    <EmptyState title="이 월드에 내 장수가 없습니다">
      <Link to="/w/$worldId/create" params={{ worldId }}>
        장수 만들기
      </Link>
    </EmptyState>
  );
}
