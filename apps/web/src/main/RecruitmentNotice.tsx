import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { NationView } from '../game/types';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';

export function RecruitmentNotice({ worldId, nation }: { worldId: string; nation: NationView }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const save = useMutation(trpc.notice.nation.setRecruitment.mutationOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const editing = nation.canEditRecruitmentNotice && draft !== null;
  return (
    <section aria-label="임관 권유문">
      <h3>임관 권유문</h3>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              { worldId, nationId: nation.id, body: draft },
              {
                onSuccess: ({ recruitmentNotice }) => {
                  queryClient.setQueryData(trpc.nation.get.queryKey({ worldId, nationId: nation.id }), (prior) =>
                    prior ? { ...prior, recruitmentNotice } : prior,
                  );
                  void queryClient.invalidateQueries({ queryKey: trpc.world.map.queryKey({ worldId }) });
                  setDraft(null);
                },
              },
            );
          }}
        >
          <label>
            공개 권유문
            <textarea rows={3} maxLength={1000} value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          {save.error ? <p role="alert">{serverMessage(save.error) ?? '권유문을 저장하지 못했습니다.'}</p> : null}
          <button type="submit" disabled={save.isPending}>
            저장
          </button>
          <button type="button" disabled={save.isPending} onClick={() => setDraft(null)}>
            취소
          </button>
        </form>
      ) : (
        <>
          <p>{nation.recruitmentNotice || '임관 권유문 없음'}</p>
          {nation.canEditRecruitmentNotice ? (
            <button
              type="button"
              onClick={() => {
                save.reset();
                setDraft(nation.recruitmentNotice ?? '');
              }}
            >
              권유문 고치기
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
