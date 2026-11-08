'use client';

import { useEffect, useRef } from 'react';
import { API_URL, session } from './api';

export interface LiveEvent {
  type: string;
  data?: any;
}

function wsUrl(query: string) {
  return `${API_URL.replace(/^http/, 'ws')}/ws?${query}`;
}

/**
 * Live updates over WebSocket, reconnecting with backoff (cheap phones drop
 * connections often). `onEvent` is called for every server event.
 */
export function useLive(query: string | null, onEvent: (e: LiveEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!query) return;
    let ws: WebSocket | null = null;
    let tries = 0;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(wsUrl(query));
      ws.onopen = () => (tries = 0);
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data);
          if (e.type !== 'hello') cb.current(e);
        } catch {}
      };
      ws.onclose = (e) => {
        if (stop || e.code === 4401) return;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** tries++));
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [query]);
}

/** Owner/staff live channel for the current business. */
export function ownerLiveQuery() {
  const t = session.token();
  const b = session.businessId();
  return t && b ? `token=${encodeURIComponent(t)}&business=${encodeURIComponent(b)}` : null;
}
