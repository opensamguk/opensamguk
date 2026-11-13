import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import { Portrait } from '../portrait/Portrait';

export function NationBoard({ worldId, nationId, canWrite }: { worldId: string; nationId: number; canWrite: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confidential, setConfidential] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [replyTo, setReplyTo] = useState<string>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const list = useQuery({
    ...trpc.nationBoard.list.queryOptions({ worldId, nationId, confidential, cursor }),
    gcTime: 0,
  });
  const write = useMutation(
    trpc.nationBoard.write.mutationOptions({
      onSuccess: async () => {
        setTitle('');
        setBody('');
        setReplyTo(undefined);
        await queryClient.invalidateQueries({ queryKey: trpc.nationBoard.list.pathKey() });
      },
    }),
  );
  const selectBoard = (next: boolean) => {
    setConfidential(next);
    setCursor(undefined);
    setReplyTo(undefined);
    setTitle('');
    setBody('');
    write.reset();
  };
  return (
    <section>
      <h2>국가 게시판</h2>
      <nav aria-label="국가 게시판">
        <button
          type="button"
          aria-pressed={!confidential}
          disabled={write.isPending}
          onClick={() => selectBoard(false)}
        >
          회의실
        </button>
        {confidential || list.data?.canReadConfidential ? (
          <button
            type="button"
            aria-pressed={confidential}
            disabled={write.isPending}
            onClick={() => selectBoard(true)}
          >
            기밀실
          </button>
        ) : null}
      </nav>
      {list.isPending ? <p role="status">게시물을 불러오는 중입니다.</p> : null}
      {list.error ? <p role="alert">{list.error.message}</p> : null}
      {list.data?.items.length === 0 ? <p>게시물이 없습니다.</p> : null}
      {list.data?.items.map((post) => (
        <article key={post.id}>
          <h3>{post.title}</h3>
          <BoardAuthor row={post} />
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.body}</p>
          {post.replyCount ? (
            <details>
              <summary>댓글 {post.replyCount}개</summary>
              {post.replyCount > post.replies.length ? <p>최근 {post.replies.length}개</p> : null}
              {post.replies.map((reply) => (
                <div key={reply.id}>
                  <BoardAuthor row={reply} />
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reply.body}</p>
                </div>
              ))}
            </details>
          ) : null}
          {canWrite ? (
            <button type="button" disabled={write.isPending} onClick={() => setReplyTo(post.id)}>
              댓글 쓰기
            </button>
          ) : null}
        </article>
      ))}
      {cursor ? (
        <button
          type="button"
          disabled={write.isPending}
          onClick={() => {
            setCursor(undefined);
            setReplyTo(undefined);
          }}
        >
          최신 글
        </button>
      ) : null}
      {list.data?.next ? (
        <button
          type="button"
          disabled={write.isPending}
          onClick={() => {
            setCursor(list.data?.next ?? undefined);
            setReplyTo(undefined);
          }}
        >
          이전 글
        </button>
      ) : null}
      {list.data && canWrite ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            write.mutate({
              worldId,
              nationId,
              confidential,
              content: replyTo ? { type: 'reply', postId: replyTo, body } : { type: 'post', title, body },
            });
          }}
        >
          <fieldset disabled={write.isPending}>
            <legend>{replyTo ? '댓글 쓰기' : '새 글 쓰기'}</legend>
            {replyTo ? (
              <>
                <p>{list.data.items.find((post) => post.id === replyTo)?.title}</p>
                <button type="button" onClick={() => setReplyTo(undefined)}>
                  댓글 취소
                </button>
              </>
            ) : (
              <label>
                제목 <input required maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
            )}
            <label>
              본문 <textarea required maxLength={1000} value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            <button type="submit">{replyTo ? '댓글 등록' : '게시물 등록'}</button>
            {write.error ? <p role="alert">{write.error.message}</p> : null}
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}

function BoardAuthor({ row }: { row: { authorName: string; portraitId: number | null; sentAt: string } }) {
  return (
    <div>
      <Portrait id={row.portraitId} name={row.authorName} variant="thumb" /> {row.authorName}{' '}
      <time dateTime={row.sentAt}>{new Date(row.sentAt).toLocaleString('ko-KR')}</time>
    </div>
  );
}
