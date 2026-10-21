import { useMemo } from 'react';

const FADE = [0.3, 0.6, 0.85];

/**
 * Visualiza el stream real que entrega Apollo: pinta el texto tal cual llega.
 * Las últimas palabras en curso llevan opacidad/color atenuados.
 * No introduce esperas ni retrasa el backend.
 */
export function StreamText({ text, active }: { text: string; active: boolean }) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);

  return (
    <p className="apollo-stream">
      {words.map((w, i) => {
        const fromEnd = words.length - 1 - i;
        const fading = active && fromEnd < FADE.length;
        return (
          <span
            key={`${i}-${w.length}`}
            style={{ opacity: fading ? FADE[fromEnd] : 1, color: fading ? 'var(--apollo-primary)' : undefined }}
          >
            {w}{' '}
          </span>
        );
      })}
    </p>
  );
}
