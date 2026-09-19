export const theme = {
  color: {
    background: '#08090D',
    panel: '#101218',
    panelAlt: '#161923',
    border: '#292D38',
    borderSoft: '#1E2029',
    text: '#E8E8EA',
    label: '#C6C8CF',
    textDim: '#858895',
    textFaint: '#4E515B',
    primary: '#A98BFF',
    primarySoft: '#C4AEFF',
    primaryDeep: '#8B6BFF',
    primaryGhost: 'rgba(169, 139, 255, 0.10)',
    primaryGlow: 'rgba(169, 139, 255, 0.35)',
    danger: '#A98BFF',
    warn: '#A98BFF',
    ok: '#A98BFF',
  },
  font: {
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Inter', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
} as const;

export type Theme = typeof theme;
