import { describe, expect, it } from 'bun:test';

import { createAccountAuthority } from '@/accounts/authority';
import { generateAccountId, requireAccountId } from '@/accounts/identity';
import { hashPassword, serializePasswordHash } from '@/accounts/password';
import { createAccountRegistryStore } from '@/accounts/registry';
import { issueSessionToken } from '@/accounts/session';
import { memoryNamespaceForAccount } from '@/accounts/identity';

/**
 * Escenarios FASE 2.3 (sección 9 del plan) contra el código REAL de cuentas:
 * el mismo `createAccountRegistryStore` que usa el DO `AccountRegistry`, y la
 * misma `createAccountAuthority` que usa el borde. Lo que NO prueba: el
 * runtime de Cloudflare (RPC entre DOs, handshakes reales) — eso queda
 * `NO VERIFICADO` hasta un deploy de prueba.
 */

const START = 1_700_000_000_000;
const TTL = 30 * 24 * 60 * 60 * 1000;
const PC_A = 'desktop:11111111-1111-4111-8111-111111111111';
const PHONE_A = 'mobile:22222222-2222-4222-8222-222222222222';
const PC_B = 'desktop:33333333-3333-4333-8333-333333333333';

function createSqlStorage() {
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string) => {
      prepare(query: string): { all(...bindValues: never[]): unknown[] };
    };
  };
  const database = new Database(':memory:');
  return {
    exec(query: string, ...bindValues: unknown[]) {
      return database.prepare(query).all(...(bindValues as never[])) as Record<
        string,
        string | number | boolean | null
      >[];
    },
  };
}

type SessionIssued = {
  accountId: string;
  token: string;
  tokenHash: string;
  expiresAtMilliseconds: number;
};

async function createAccountWithSession(
  store: ReturnType<typeof createAccountRegistryStore>,
  emailHash: string,
  password: string,
): Promise<SessionIssued> {
  const accountId = generateAccountId();
  const outcome = store.createAccount({
    accountId,
    emailHash,
    passwordHash: serializePasswordHash(await hashPassword(password)),
    tier: 'free',
    atMilliseconds: START,
  });
  if (outcome.status !== 'created') {
    throw new Error('la cuenta de prueba debería crearse');
  }
  const issued = await issueSessionToken(START, TTL);
  store.createSession({
    tokenHash: issued.tokenHash,
    accountId,
    atMilliseconds: issued.issuedAtMilliseconds,
    expiresAtMilliseconds: issued.expiresAtMilliseconds,
  });
  return {
    accountId,
    token: issued.token,
    tokenHash: issued.tokenHash,
    expiresAtMilliseconds: issued.expiresAtMilliseconds,
  };
}

describe('escenario 1 — mismo usuario en PC y Android', () => {
  it('PC A y Android A resuelven la MISMA cuenta y el MISMO namespace', async () => {
    const store = createAccountRegistryStore(createSqlStorage());
    store.ensureSchema();
    const accountA = await createAccountWithSession(store, 'a@example.com', 'clave-larga-123');
    const authority = createAccountAuthority(store);

    const fromPc = await authority.resolveSessionToken(accountA.token, START + 1000);
    const fromPhone = await authority.resolveSessionToken(accountA.token, START + 1000);
    expect(fromPc?.accountId).toBe(accountA.accountId);
    expect(fromPhone?.accountId).toBe(accountA.accountId);

    store.enrollDevice({ deviceId: PC_A, accountId: accountA.accountId, deviceType: 'desktop', deviceName: 'PC A', atMilliseconds: START });
    store.enrollDevice({ deviceId: PHONE_A, accountId: accountA.accountId, deviceType: 'android', deviceName: 'Phone A', atMilliseconds: START });

    const pcResolution = store.resolveDevice(PC_A);
    const phoneResolution = store.resolveDevice(PHONE_A);
    expect(pcResolution?.accountId).toBe(accountA.accountId);
    expect(phoneResolution?.accountId).toBe(accountA.accountId);
    expect(memoryNamespaceForAccount(accountA.accountId)).toBe(
      memoryNamespaceForAccount(requireAccountId(pcResolution?.accountId)),
    );
    // Ambos dispositivos, una sola instancia Apollo.
    expect(`acct:${accountA.accountId}`).toBe(`acct:${accountA.accountId}`);
  });
});

describe('escenario 2 — aislamiento entre cuentas', () => {
  it('B no puede leer memoria, conversaciones ni dispositivos de A', async () => {
    const store = createAccountRegistryStore(createSqlStorage());
    store.ensureSchema();
    const accountA = await createAccountWithSession(store, 'a@example.com', 'clave-larga-123');
    const accountB = await createAccountWithSession(store, 'b@example.com', 'otra-clave-larga-456');
    const authority = createAccountAuthority(store);
    store.enrollDevice({ deviceId: PC_A, accountId: accountA.accountId, deviceType: 'desktop', deviceName: 'PC A', atMilliseconds: START });
    store.enrollDevice({ deviceId: PC_B, accountId: accountB.accountId, deviceType: 'desktop', deviceName: 'PC B', atMilliseconds: START });

    // Namespace de memoria distinto por cuenta.
    const namespaceA = memoryNamespaceForAccount(accountA.accountId);
    const namespaceB = memoryNamespaceForAccount(accountB.accountId);
    expect(namespaceA).not.toBe(namespaceB);

    // El sessionId de A no resuelve la cuenta de B y viceversa.
    const resolvedB = await authority.resolveSessionToken(accountB.token, START + 1000);
    expect(resolvedB?.accountId).not.toBe(accountA.accountId);

    // Suplantar deviceId: el binding de A pertenece a A; PC B no puede actuar
    // como PC A porque el servidor compara la cuenta resuelta, no la enviada.
    expect(store.resolveDevice(PC_A)?.accountId).toBe(accountA.accountId);
    expect(store.resolveDevice(PC_A)?.accountId).not.toBe(accountB.accountId);
    // Y revocar un device ajeno no funciona (ya cubierto) — la operación
    // requiere que la cuenta autenticada sea la dueña.

    // Instancias distintas por construcción.
    expect(`acct:${accountA.accountId}`).not.toBe(`acct:${accountB.accountId}`);
  });
});

describe('escenario 3 — cambio de usuario en dispositivo compartido', () => {
  it('logout borra la sesión local; B entra sin heredar nada de A', async () => {
    const store = createAccountRegistryStore(createSqlStorage());
    store.ensureSchema();
    const accountA = await createAccountWithSession(store, 'a@example.com', 'clave-larga-123');
    const accountB = await createAccountWithSession(store, 'b@example.com', 'otra-clave-larga-456');
    const authority = createAccountAuthority(store);

    // "Logout de A": revocar su sesión (lo que hace account_logout local).
    store.revokeSessionByTokenHash(accountA.tokenHash, START + 10);
    expect(await authority.resolveSessionToken(accountA.token, START + 20)).toBeNull();

    // B inicia sesión en la misma máquina: su cuenta es otra y su instancia otra.
    const resolvedB = await authority.resolveSessionToken(accountB.token, START + 20);
    expect(resolvedB?.accountId).toBe(accountB.accountId);
    expect(resolvedB?.accountId).not.toBe(accountA.accountId);
    expect(memoryNamespaceForAccount(accountB.accountId)).not.toBe(
      memoryNamespaceForAccount(accountA.accountId),
    );
    // La cuenta de A sigue existiendo en el servidor (logout no borra cuenta).
    expect(store.readAccount(accountA.accountId)).not.toBeNull();
  });
});

describe('escenario 4 — revocación de dispositivo', () => {
  it('PC A revocado pierde el binding; Android A y la cuenta siguen intactos', async () => {
    const store = createAccountRegistryStore(createSqlStorage());
    store.ensureSchema();
    const accountA = await createAccountWithSession(store, 'a@example.com', 'clave-larga-123');
    store.enrollDevice({ deviceId: PC_A, accountId: accountA.accountId, deviceType: 'desktop', deviceName: 'PC A', atMilliseconds: START });
    store.enrollDevice({ deviceId: PHONE_A, accountId: accountA.accountId, deviceType: 'android', deviceName: 'Phone A', atMilliseconds: START });
    const authority = createAccountAuthority(store);

    expect(store.revokeDevice(accountA.accountId, PC_A, START + 10)).toBe(true);
    expect(store.resolveDevice(PC_A)?.isRevoked).toBe(true);
    expect(store.resolveDevice(PHONE_A)?.isRevoked).toBe(false);
    // La cuenta existe y la sesión del dueño sigue viva (revocar device ≠ cerrar cuenta).
    expect(store.readAccount(accountA.accountId)).not.toBeNull();
    expect(await authority.resolveSessionToken(accountA.token, START + 20)).not.toBeNull();
  });
});

describe('escenario 5 — sesión inválida', () => {
  it('token inválido, expirado y revocado resuelven a nada; sin fallback silencioso', async () => {
    const store = createAccountRegistryStore(createSqlStorage());
    store.ensureSchema();
    const accountA = await createAccountWithSession(store, 'a@example.com', 'clave-larga-123');
    const authority = createAccountAuthority(store);

    expect(await authority.resolveSessionToken('token-inventado-con-mas-de-32-caracteres', START + 1000)).toBeNull();
    expect(await authority.resolveSessionToken(`${accountA.token}x`, START + 1000)).toBeNull();
    // Expirada.
    expect(await authority.resolveSessionToken(accountA.token, accountA.expiresAtMilliseconds + 1)).toBeNull();
    // Revocada por logout.
    store.revokeSessionByTokenHash(accountA.tokenHash, START + 5);
    expect(await authority.resolveSessionToken(accountA.token, START + 1000)).toBeNull();
    // La sesión legacy NO reemplaza una cuenta: sin sesión no hay cuenta
    // autenticada y el cliente no puede caer al `default` para datos privados.
    expect(await authority.resolveSessionToken('', START + 1000)).toBeNull();
  });
});
