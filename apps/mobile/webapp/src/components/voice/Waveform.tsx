import { useEffect, useRef } from 'react';
import { audioBus } from './audioBus';
import type { OrbVoiceState } from '@/components/Orb/Orb';

const W = 260;
const H = 48;
const N = 48;

export function Waveform({ state }: { state: OrbVoiceState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    c.width = W * dpr;
    c.height = H * dpr;
    g.scale(dpr, dpr);

    const hs = new Float32Array(N).fill(2);
    let raf = 0;

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      const st = stateRef.current;
      const active = st === 'listening' || st === 'answering';
      g.clearRect(0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const d = Math.abs((i / (N - 1)) * 2 - 1);
        let goal = 2;
        if (active) goal += (audioBus.bins[Math.floor(d * 40)] / 255) * H * (1 - d * 0.6);
        else if (st === 'thinking') goal += (Math.sin(t / 250 - i * 0.4) * 0.5 + 0.5) * 6;
        hs[i] += (goal - hs[i]) * 0.3;
        // cyan -> azul -> mint, sin violetas
        const hue = 190 - (i / N) * 40;
        g.fillStyle = `hsl(${hue} 85% 60% / ${active ? 1 : 0.55})`;
        g.fillRect(i * (W / N) + 1, (H - hs[i]) / 2, 3, hs[i]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} style={{ width: W, height: H }} aria-hidden />;
}
