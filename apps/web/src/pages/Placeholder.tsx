import { EmptyState } from '../ui/States';

// 데이터 연결 전 자리표시 화면. 어느 작업에서 채우는지 적어 둔다.
export function Placeholder({ title, task, children }: { title: string; task: string; children?: React.ReactNode }) {
  return (
    <section>
      <h1>{title}</h1>
      <EmptyState title={`${task}에서 연결합니다`}>{children}</EmptyState>
    </section>
  );
}
