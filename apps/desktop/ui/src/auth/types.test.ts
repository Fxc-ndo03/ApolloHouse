import { describe, expect, it } from 'bun:test';

import {
  buildRegistrationCredentials,
  isValidEmail,
  MAX_PASSWORD,
  MIN_PASSWORD,
  normalizeEmail,
  passwordIssue,
} from './types';

/**
 * El backend es la autoridad: `apps/agent/src/accounts/do.ts:28-29` exige
 * 10..256 caracteres y `apps/agent/src/auth/routes.ts:45-51` acepta SOLO
 * `email` y `password` en el registro. Estos tests fijan ese contrato para que
 * la UI no vuelva a divergir.
 */

const PASSWORD_AT_MINIMUM = 'a'.repeat(MIN_PASSWORD);

describe('validación de correo', () => {
  it('acepta un correo bien formado y normaliza a minúsculas sin espacios', () => {
    expect(isValidEmail('  Persona@Ejemplo.COM ')).toBe(true);
    expect(normalizeEmail('  Persona@Ejemplo.COM ')).toBe('persona@ejemplo.com');
  });

  it('rechaza correos mal formados', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('sin-arroba')).toBe(false);
    expect(isValidEmail('falta@dominio')).toBe(false);
    expect(isValidEmail('espacio en@ejemplo.com')).toBe(false);
    expect(isValidEmail('@ejemplo.com')).toBe(false);
  });
});

describe('límites de contraseña, según el backend', () => {
  it('rechaza 9 caracteres', () => {
    expect(passwordIssue('a'.repeat(MIN_PASSWORD - 1))).toBe(
      `Use at least ${MIN_PASSWORD} characters.`,
    );
  });

  it('acepta exactamente 10 caracteres', () => {
    expect(passwordIssue(PASSWORD_AT_MINIMUM)).toBeNull();
    expect(PASSWORD_AT_MINIMUM).toHaveLength(10);
  });

  it('acepta exactamente 256 caracteres', () => {
    expect(passwordIssue('a'.repeat(MAX_PASSWORD))).toBeNull();
  });

  it('rechaza 257 caracteres', () => {
    expect(passwordIssue('a'.repeat(MAX_PASSWORD + 1))).toBe(
      `Use at most ${MAX_PASSWORD} characters.`,
    );
  });

  it('no exige letras y dígitos: el backend solo mira el largo', () => {
    // `isAcceptablePassword` (accounts/do.ts:48-50) solo compara longitudes. Si
    // la UI exigiera letras y dígitos, rechazaria contrasenas que el servidor
    // acepta.
    expect(passwordIssue('1234567890')).toBeNull();
    expect(passwordIssue('abcdefghij')).toBeNull();
  });
});

describe('payload de registro', () => {
  it('envía exactamente email y password: ningún campo de nombre', () => {
    const credentials = buildRegistrationCredentials('  Persona@Ejemplo.com ', PASSWORD_AT_MINIMUM);
    expect(Object.keys(credentials).sort()).toEqual(['email', 'password']);
    expect('name' in credentials).toBe(false);
    expect(credentials.email).toBe('persona@ejemplo.com');
    expect(credentials.password).toBe(PASSWORD_AT_MINIMUM);
  });
});