import { useEffect, useEffectEvent } from 'react';

export function useAdminResultPolling(requestId: string | null, paused: boolean, read: (id: string) => void) {
  const poll = useEffectEvent(read);
  useEffect(() => {
    if (!requestId || paused) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) poll(requestId);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [paused, requestId]);
}
