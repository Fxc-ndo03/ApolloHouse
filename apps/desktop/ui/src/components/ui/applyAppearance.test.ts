import { describe, expect, it } from 'bun:test';
import { resolveAppearanceMode } from './applyAppearance';

describe('resolveAppearanceMode', () => {
  it('uses the current system theme when appearance is automatic', () => {
    expect(resolveAppearanceMode('system', 'dark')).toBe('dark');
    expect(resolveAppearanceMode('system', 'light')).toBe('light');
  });

  it('preserves a user-selected theme across system changes', () => {
    expect(resolveAppearanceMode('dark', 'light')).toBe('dark');
    expect(resolveAppearanceMode('light', 'dark')).toBe('light');
  });
});
