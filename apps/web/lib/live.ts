'use client';

import { useEffect, useRef } from 'react';
import { apiUrl, freshToken, session, sessionEnded } from './api';

export interface LiveEvent {
  type: string;
  data?: any;
}

/** A WebSocket address on the API (path like "/ws" or "/voice/web"). */
export function socketUrl(path: string, query: string) {
  // API_URL may be relative ("/api") when the API sits behind the same address as the web app.
  if (apiUrl().startsWith('/')) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${apiUrl()}${path}?${query}`;
  return `${apiUrl().replace(/^http/, 'ws')}${path}?${query}`;
}

const wsUrl = (query: string) => socketUrl('/ws', query);

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
    let renewed = false;
    const connect = async () => {
      // Owner sockets carry the sign-in token: use a fresh one on every (re)connect, never the one from when the page opened.
      let q = query;
      if (/(^|&)token=/.test(q)) {
        const t = await freshToken().catch(() => null);
        if (stop) return;
        if (!t) return sessionEnded();
        q = q.replace(/(^|&)token=[^&]*/, `$1token=${encodeURIComponent(t)}`);
      }
      ws = new WebSocket(wsUrl(q));
      ws.onopen = () => (tries = 0);
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data);
          if (e.type !== 'hello') cb.current(e);
        } catch {}
      };
      ws.onclose = (e) => {
        if (stop) return;
        if (e.code === 4401) {
          // Not accepted: renew the token once; if it still fails, the sign-in has ended.
          if (renewed || !/(^|&)token=/.test(query)) return /(^|&)token=/.test(query) ? sessionEnded() : undefined;
          renewed = true;
          freshToken(true).then((t) => (t ? connect() : sessionEnded())).catch(() => sessionEnded());
          return;
        }
        renewed = false;
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
