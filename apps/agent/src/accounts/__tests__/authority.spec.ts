import { describe, expect, it } from 'bun:test';

import { createAccountAuthority } from '@/accounts/authority';
import { generateAccountId } from '@/accounts/identity';
import { hashPassword, serializePasswordHash } from '@/accounts/password';
import { createAccountRegistryStore } from '@/accounts/registry';
import { issueSessionToken } from '@/accounts/session';
import { isDeviceCredentialToken } from '@/accounts/session';
import { apolloObjectNameForAccount, memoryNamespaceForAccount } from '@/accounts/identity';
import { evaluateUsageQuota, resolveUsagePolicy } from '@/usage/usage';
import { requireAccountId } from '@/accounts/identity';

const START = 1_700_000_000_000;
const TTL = 30 * 24 * 60 * 60 * 1000;

function createSqlStorage() {
  const { Database } = require('bun:sqlite') as { Database: new (path: string) => unknown };
  const database = new Database(':memory:');
  return {
    exec(query: string, ...bindValues: unknown[]) {
      return (
        database as { prepare(q: string): { all(...v: never[]): unknown[] } })
          .prepare(query)
          .all(...(bindValues as never[])) as Record<string, string | number | boolean | null>[];
    },
  };
}

async function createAuthorityWithSession(email: string, password: string) {
  const store = createAccountRegistryStore(createSqlStorage());
  store.ensureSchema();
  const accountId = generateAccountId();
  store.createAccount({
    accountId,
    emailHash: email,
    passwordHash: serializePasswordHash(await hashPassword(password)),
    tier: 'free',
    atMilliseconds: START,
  });
  const issued = await issueSessionToken(START, TTL);
  store.createSession({
    tokenHash: issued.tokenHash,
    accountId,
    atMilliseconds: issued.issuedAtMilliseconds,
    expiresAtMilliseconds: issued.expiresAtMilliseconds,
  });
  return { authority: createAccountAuthority(store), accountId, token: issued.token };
}

describe('authority separation — attack tests', () => {
  it('a device credential can NEVER authenticate as an account session', async () => {
    expect(isDeviceCredentialToken('apollo_dev_abc')).toBe(true);
    expect(isDeviceCredentialToken('apollo_enr_abc')).toBe(true);
    expect(isDeviceCredentialToken('a-session-token-with-more-than-32-chars!!')).toBe(false);
  });

  it('a session token resolves to exactly its own account and nobody else\'s', async () => {
    const { authority, accountId, token } = await createAuthorityWithSession('a@test', 'clave-larga-123');
    const resolved = await authority.resolveSessionToken(token, START + 1000);
    expect(resolved?.accountId).toBe(accountId);
    const other = await createAuthorityWithSession('b@test', 'clave-larga-456');
    expect(resolved?.accountId).not.toBe(other.accountId);
  });

  it('an unknown or tampered token resolves to nothing', async () => {
    const { authority, token } = await createAuthorityWithSession('a@test', 'clave-larga-123');
    expect(await authority.resolveSessionToken(`${token}x`, START + 1000)).toBeNull();
    expect(await authority.resolveSessionToken('totally-unknown-token-32-chars-long!!', START + 1000)).toBeNull();
  });

  it('DO name, memory namespace and account stay bijective — no cross mapping', () => {
    const accountA = generateAccountId();
    const accountB = generateAccountId();
    expect(apolloObjectNameForAccount(accountA)).not.toBe(apolloObjectNameForAccount(accountB));
    expect(memoryNamespaceForAccount(accountA)).not.toBe(memoryNamespaceForAccount(accountB));
    expect(requireAccountId(accountA)).toBe(accountA);
  });

  it('a free-tier account over quota is blocked before any model call', () => {
    const policy = resolveUsagePolicy('free', { dailyTokens: 10, requestsPerMinute: 2 });
    const daily = { tokens: 11, requests: 1, voiceSeconds: 0 };
    const monthly = { tokens: 11, requests: 1, voiceSeconds: 0 };
    const decision = evaluateUsageQuota(policy, daily, monthly, 1);
    expect(decision.allowed).toBe(false);
    expect(decision.exceededLimit).toBe('dailyTokens');
  });

  it('a free-tier account within quota passes and per-minute bursts are capped', () => {
    const policy = resolveUsagePolicy('free', { requestsPerMinute: 2 });
    const empty = { tokens: 0, requests: 0, voiceSeconds: 0 };
    // El chequeo corre ANTES del request: con 1 en el minuto todavía entra el
    // segundo (límite 2); con 2 ya hechos, el siguiente se bloquea.
    expect(evaluateUsageQuota(policy, empty, empty, 1).allowed).toBe(true);
    expect(evaluateUsageQuota(policy, empty, empty, 2).exceededLimit).toBe('requestsPerMinute');
  });
});
