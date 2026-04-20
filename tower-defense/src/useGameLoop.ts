import { useRef, useEffect, useCallback } from 'react';

export function useGameLoop(tick: (dt: number, now: number) => void, active: boolean) {
  const rafRef = useRef<number>(0);
  const lastRef = useRef<number>(0);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  const loop = useCallback((now: number) => {
    const dt = Math.min((now - lastRef.current) / 1000, 0.1); // cap at 100ms
    lastRef.current = now;
    tickRef.current(dt, now);
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    lastRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, loop]);
}
