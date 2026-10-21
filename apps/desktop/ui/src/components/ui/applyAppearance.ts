import type { Appearance } from '@/store';

const ACCENTS: Record<Appearance['accent'], { primary: string; primary2: string }> = {
  ocean: { primary: '#38BDF8', primary2: '#22D3EE' },
  cyan: { primary: '#67D9FF', primary2: '#42E8E0' },
  mint: { primary: '#63F2B0', primary2: '#42E8E0' },
  blue: { primary: '#5B8CFF', primary2: '#67D9FF' },
};

const TEXT_SCALE: Record<Appearance['textSize'], number> = {
  small: 0.9,
  default: 1,
  large: 1.12,
  xl: 1.25,
};

const UI_RADIUS: Record<Appearance['uiStyle'], { r: string; rsm: string }> = {
  rounded: { r: '18px', rsm: '12px' },
  soft: { r: '14px', rsm: '9px' },
  crisp: { r: '8px', rsm: '5px' },
};

export type ResolvedAppearanceMode = Exclude<Appearance['mode'], 'system'>;

export function resolveAppearanceMode(
  mode: Appearance['mode'],
  systemMode: ResolvedAppearanceMode,
): ResolvedAppearanceMode {
  return mode === 'system' ? systemMode : mode;
}

/**
 * Única fuente de verdad para aplicar apariencia: escribe variables CSS en
 * `:root` y el modo en `data-apollo-theme`. Todo el cambio visual sale de aquí.
 */
export function applyAppearance(
  a: Appearance,
  systemMode?: ResolvedAppearanceMode,
) {
  const root = document.documentElement;
  const accent = ACCENTS[a.accent];
  const detectedSystemMode = systemMode ?? (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : 'dark'
  );
  root.dataset.apolloTheme = resolveAppearanceMode(a.mode, detectedSystemMode);
  root.style.setProperty('--apollo-primary', accent.primary);
  root.style.setProperty('--apollo-primary-2', accent.primary2);
  root.style.setProperty('--apollo-cyan', accent.primary2);
  root.style.setProperty('--apollo-blue', accent.primary);
  root.style.setProperty('--apollo-fs', String(TEXT_SCALE[a.textSize]));
  root.style.setProperty('--apollo-radius', UI_RADIUS[a.uiStyle].r);
  root.style.setProperty('--apollo-radius-sm', UI_RADIUS[a.uiStyle].rsm);
}
