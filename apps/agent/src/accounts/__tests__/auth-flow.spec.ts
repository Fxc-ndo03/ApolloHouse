import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { generateAccountId } from '@/accounts/identity';
import { hashPassword, serializePasswordHash, verifyPassword } from '@/accounts/password';
import { createAccountRegistryStore } from '@/accounts/registry';
import { sha256Hex } from '@/accounts/session';

const START_MILLISECONDS = 1_700_000_000_000;
const TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

function createSqlStorage() {
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

function createRegistry() {
  return createAccountRegistryStore(createSqlStorage());
}

describe('account registry — auth flows', () => {
  it('creates an account with a hashed password and never stores plaintext', async () => {
    const store = createRegistry();
    store.ensureSchema();
    const passwordHash = serializePasswordHash(await hashPassword('correct horse battery'));
    const outcome = store.createAccount({
      accountId: generateAccountId(),
      emailHash: await sha256Hex('a@example.com'),
      passwordHash,
      tier: 'free',
      atMilliseconds: START_MILLISECONDS,
    });
    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') {
      throw new Error('expected created');
    }
    expect(outcome.account.passwordHash).toContain('pbkdf2-sha256$');
    expect(outcome.account.passwordHash).not.toContain('correct horse');
  });

  it('rejects a duplicate email and accepts a second account', async () => {
    const store = createRegistry();
    store.ensureSchema();
    const emailHash = await sha256Hex('a@example.com');
    const passwordHash = serializePasswordHash(await hashPassword('long enough pass'));
    expect(
      store.createAccount({ accountId: generateAccountId(), emailHash, passwordHash, tier: 'free', atMilliseconds: 1 }).status,
    ).toBe('created');
    expect(
      store.createAccount({ accountId: generateAccountId(), emailHash, passwordHash, tier: 'free', atMilliseconds: 2 }).status,
    ).toBe('email_taken');
  });

  it('resolves a live session and never resolves an expired one', async () => {
    const store = createRegistry();
    store.ensureSchema();
    const accountId = generateAccountId();
    store.createAccount({ accountId, emailHash: 'h', passwordHash: 'p', tier: 'free', atMilliseconds: START_MILLISECONDS });
    const issued = await import('@/accounts/session').then((m) => m.issueSessionToken(START_MILLISECONDS, TTL_MILLISECONDS));
    store.createSession({
      tokenHash: issued.tokenHash,
      accountId,
      atMilliseconds: issued.issuedAtMilliseconds,
      expiresAtMilliseconds: issued.expiresAtMilliseconds,
    });

    const live = store.resolveSessionByTokenHash(issued.tokenHash, START_MILLISECONDS + 1000);
    expect(live).not.toBeNull();
    expect(live?.accountId).toBe(accountId);

    const expired = store.resolveSessionByTokenHash(issued.tokenHash, issued.expiresAtMilliseconds + 1);
    expect(expired).toBeNull();
  });

  it('revokes one session without touching the others', async () => {
    const store = createRegistry();
    store.ensureSchema();
    const accountId = generateAccountId();
    store.createAccount({ accountId, emailHash: 'h', passwordHash: 'p', tier: 'free', atMilliseconds: START_MILLISECONDS });
    const first = await import('@/accounts/session').then((m) => m.issueSessionToken(START_MILLISECONDS));
    const second = await import('@/accounts/session').then((m) => m.issueSessionToken(START_MILLISECONDS));
    for (const issued of [first, second]) {
      store.createSession({
        tokenHash: issued.tokenHash,
        accountId,
        atMilliseconds: issued.issuedAtMilliseconds,
        expiresAtMilliseconds: issued.expiresAtMilliseconds,
      });
    }

    expect(store.revokeSessionByTokenHash(first.tokenHash, START_MILLISECONDS + 1)).toBe(true);
    expect(store.resolveSessionByTokenHash(first.tokenHash, START_MILLISECONDS + 2)).toBeNull();
    expect(store.resolveSessionByTokenHash(second.tokenHash, START_MILLISECONDS + 2)).not.toBeNull();
    expect(store.revokeSessionByTokenHash(first.tokenHash, START_MILLISECONDS + 3)).toBe(false);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = serializePasswordHash(await hashPassword('una clave larga 123'));
    expect(await verifyPassword('una clave larga 123', hash)).toBe(true);
    expect(await verifyPassword('otra clave', hash)).toBe(false);
    expect(await verifyPassword('una clave larga 123', 'garbage')).toBe(false);
    expect(await verifyPassword('una clave larga 123', 'pbkdf2-sha256$abc$x$y')).toBe(false);
  });

  it('keeps device binding scoped to one account and revocable without killing sessions', async () => {
    const store = createRegistry();
    store.ensureSchema();
    const accountIdA = generateAccountId();
    const accountIdB = generateAccountId();
    store.createAccount({ accountId: accountIdA, emailHash: 'ha', passwordHash: 'p', tier: 'free', atMilliseconds: 1 });
    store.createAccount({ accountId: accountIdB, emailHash: 'hb', passwordHash: 'p', tier: 'free', atMilliseconds: 1 });

    const enrollOutcome = store.enrollDevice({
      deviceId: 'desktop:11111111-2222-3333-4444-555555555555',
      accountId: accountIdA,
      deviceType: 'desktop',
      deviceName: 'PC A',
      atMilliseconds: 10,
    });
    expect(enrollOutcome.status).toBe('enrolled');

    const liveSession = await import('@/accounts/session').then((m) => m.issueSessionToken(10));
    store.createSession({ tokenHash: liveSession.tokenHash, accountId: accountIdA, atMilliseconds: 10, expiresAtMilliseconds: 10 + TTL_MILLISECONDS });

    expect(store.revokeDevice(accountIdB, 'desktop:11111111-2222-3333-4444-555555555555', 20)).toBe(false);
    expect(store.revokeDevice(accountIdA, 'desktop:11111111-2222-3333-4444-555555555555', 20)).toBe(true);

    const revokedDevice = store.resolveDevice('desktop:11111111-2222-3333-4444-555555555555');
    expect(revokedDevice?.isRevoked).toBe(true);
    expect(store.resolveSessionByTokenHash(liveSession.tokenHash, 30)).not.toBeNull();
  });

  it('isolates device lists per account', () => {
    const store = createRegistry();
    store.ensureSchema();
    const accountIdA = generateAccountId();
    const accountIdB = generateAccountId();
    store.createAccount({ accountId: accountIdA, emailHash: 'ha', passwordHash: 'p', tier: 'free', atMilliseconds: 1 });
    store.createAccount({ accountId: accountIdB, emailHash: 'hb', passwordHash: 'p', tier: 'free', atMilliseconds: 1 });
    store.enrollDevice({ deviceId: 'desktop:aaaaaaaa-1111-1111-1111-111111111111', accountId: accountIdA, deviceType: 'desktop', deviceName: 'PC A', atMilliseconds: 2 });
    store.enrollDevice({ deviceId: 'mobile:bbbbbbbb-2222-2222-2222-222222222222', accountId: accountIdB, deviceType: 'android', deviceName: 'Phone B', atMilliseconds: 2 });

    const devicesA = store.listDevices(accountIdA).map((device) => device.deviceId);
    const devicesB = store.listDevices(accountIdB).map((device) => device.deviceId);
    expect(devicesA).toEqual(['desktop:aaaaaaaa-1111-1111-1111-111111111111']);
    expect(devicesB).toEqual(['mobile:bbbbbbbb-2222-2222-2222-222222222222']);
    expect(devicesA.some((deviceId) => devicesB.includes(deviceId))).toBe(false);
  });
});
