'use client';

import { useEffect, useRef, useState } from 'react';

/** True when the user asked for less motion (OS setting). */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Entrance animations play once per session; returning to The Bridge is instant (spec 5.9). */
export function useIntroOnce(key: string, ready: boolean) {
  const [play, setPlay] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ready || play !== null) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(key) === '1';
      sessionStorage.setItem(key, '1');
    } catch {}
    setPlay(!seen && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, [key, ready, play]);
  return play === true;
}

/** Pause continuous animations while the tab or app is in the background. */
export function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Count a number up from 0 over `ms` (once, when `animate` is true); later changes update instantly. */
export function useCountUp(value: number, animate: boolean, ms = 1600) {
  const [shown, setShown] = useState(animate ? 0 : value);
  const done = useRef(!animate);
  useEffect(() => {
    if (done.current) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setShown(value * easeOutCubic(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else done.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** Cycle through items every `ms` (paused when hidden). */
export function useCycle(length: number, ms = 2600, running = true) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!running || length < 2) return;
    const id = setInterval(() => setI((x) => (x + 1) % length), ms);
    return () => clearInterval(id);
  }, [length, ms, running]);
  return length ? i % length : 0;
}
