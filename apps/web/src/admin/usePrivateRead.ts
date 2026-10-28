import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { publicFailure } from '../auth/credentials';
import { useTRPCClient } from '../trpc';

// 민감한 결과는 공통 query cache와 저장소에 넣지 않는다. 새 요청과 focus는 이전 결과를 지운다.
export function usePrivateRead<T>(viewerId: string) {
  const client = useTRPCClient(),
    router = useRouter();
  const generation = useRef(0),
    active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ data: T | null; pending: boolean; error: string | null }>({
    data: null,
    pending: false,
    error: null,
  });
  const clear = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setState({ data: null, pending: false, error: null });
  }, []);
  useEffect(() => {
    for (const event of ['focus', 'blur', 'online', 'offline']) window.addEventListener(event, clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      for (const event of ['focus', 'blur', 'online', 'offline']) window.removeEventListener(event, clear);
      document.removeEventListener('visibilitychange', clear);
      generation.current++;
      active.current?.abort();
    };
  }, [clear, viewerId]);

  async function read(query: (signal: AbortSignal) => Promise<T>) {
    clear();
    const own = generation.current,
      controller = new AbortController();
    active.current = controller;
    setState({ data: null, pending: true, error: null });
    const results = await Promise.allSettled([
      client.auth.me.query(undefined, { signal: controller.signal }),
      Promise.resolve().then(() => query(controller.signal)),
    ]);
    if (generation.current !== own || controller.signal.aborted) return;
    active.current = null;
    const identity = results[0],
      result = results[1];
    const denied = results.some(
      (item) =>
        item.status === 'rejected' && ['UNAUTHORIZED', 'FORBIDDEN'].includes(publicFailure(item.reason)?.code ?? ''),
    );
    if (denied || (identity.status === 'fulfilled' && identity.value.user?.id !== viewerId)) {
      setState({ data: null, pending: false, error: '계정과 권한을 다시 확인합니다.' });
      void router.invalidate();
      return;
    }
    if (identity.status === 'rejected' || result.status === 'rejected') {
      setState({ data: null, pending: false, error: '조회하지 못했습니다. 입력을 확인한 뒤 다시 조회하세요.' });
      return;
    }
    setState({ data: result.value, pending: false, error: null });
  }
  return { ...state, read, clear };
}
