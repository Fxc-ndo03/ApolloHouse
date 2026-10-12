import { describe, expect, it } from 'bun:test';

import {
  areTextsEqualTimingSafe,
  isDeviceSharedSecretValid,
  isInternalCoreTokenValid,
  readDeviceTokenFromRequestUrl,
} from '@/auth/token';

describe('device token', () => {
  it('reads token query param', () => {
    const requestUrl = new URL('https://example.com/agents/apollo?token=abc');
    expect(readDeviceTokenFromRequestUrl(requestUrl)).toBe('abc');
  });

  it('accepts matching secret with timing-safe compare', async () => {
    await expect(isDeviceSharedSecretValid('secret', 'secret')).resolves.toBe(true);
    await expect(isDeviceSharedSecretValid('nope', 'secret')).resolves.toBe(false);
    await expect(isDeviceSharedSecretValid(null, 'secret')).resolves.toBe(false);
  });

  it('rejects instead of throwing when the worker secret is unset', async () => {
    await expect(isDeviceSharedSecretValid('abc', '')).resolves.toBe(false);
    await expect(isDeviceSharedSecretValid('abc', undefined)).resolves.toBe(false);
  });
});

describe('BLOCK 12.2 §3: el token interno', () => {
  it('acepta sólo el token exacto', () => {
    expect(isInternalCoreTokenValid('token-interno', 'token-interno')).toBe(true);
    expect(isInternalCoreTokenValid('otro', 'token-interno')).toBe(false);
    expect(isInternalCoreTokenValid(null, 'token-interno')).toBe(false);
  });

  it('falla cerrado si el binding no está provisionado', () => {
    // El `===` anterior también fallaba cerrado, pero por casualidad
    // (`null === undefined`). Con un valor vacío el coincidence se volvía real.
    expect(isInternalCoreTokenValid('token-interno', undefined)).toBe(false);
    expect(isInternalCoreTokenValid('token-interno', '')).toBe(false);
    expect(isInternalCoreTokenValid('', '')).toBe(false);
    expect(isInternalCoreTokenValid(null, undefined)).toBe(false);
  });

  it('comparación sin canal por longitud ni por posición', () => {
    expect(areTextsEqualTimingSafe('igual', 'igual')).toBe(true);
    expect(areTextsEqualTimingSafe('igual', 'igual ')).toBe(false);
    // Un prefijo compartido no alcanza: si la comparación cortara en el primer
    // byte distinto, esto y `totalmente-distinto` cuestan lo mismo, y eso ya es un
    // canal sobre el secreto.
    expect(areTextsEqualTimingSafe('token-interno', 'token-interno-distinto')).toBe(
      false,
    );
  });
});
