import { DurableObject } from 'cloudflare:workers';

import { createAccountAuthority } from '@/accounts/authority';
import { generateAccountId, isValidAccountId } from '@/accounts/identity';
import {
  emailLookupHash,
  hashPassword,
  serializePasswordHash,
  verifyPassword,
} from '@/accounts/password';
import { createAccountRegistryStore, type AccountRegistryStore, type RegistryRow } from '@/accounts/registry';
import { issueSessionToken } from '@/accounts/session';

export type AuthIssueOutcome =
  | { readonly status: 'ok'; readonly accountId: string; readonly token: string; readonly expiresAtMilliseconds: number }
  | { readonly status: 'email_taken'; readonly accountId: null }
  | { readonly status: 'invalid_credentials'; readonly accountId: null }
  | { readonly status: 'malformed_input'; readonly accountId: null };

export type SessionOutcome =
  | { readonly status: 'ok'; readonly accountId: string }
  | { readonly status: 'unauthorized' };

export type DeviceListOutcome =
  | { readonly status: 'ok'; readonly devices: readonly { deviceId: string; deviceType: string; deviceName: string; createdAtMilliseconds: number }[] }
  | { readonly status: 'unauthorized' };

const MINIMUM_PASSWORD_LENGTH = 10;
const MAXIMUM_PASSWORD_LENGTH = 256;

/**
 * Iteraciones de PBKDF2 configurables por entorno. El default (210k) cumple
 * OWASP; en el plan free de Workers puede superar el límite de CPU por
 * request (verificado en staging FASE 2.5) — allí se baja por config.
 */
function resolvePbkdf2Iterations(environment: Env): number {
  const parsed = Number(environment.APOLLO_PBKDF2_ITERATIONS);
  if (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 10_000_000) {
    return parsed;
  }
  return 210_000;
}

function isWellFormedEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

function isAcceptablePassword(password: string): boolean {
  return password.length >= MINIMUM_PASSWORD_LENGTH && password.length <= MAXIMUM_PASSWORD_LENGTH;
}

/**
 * Global singleton DO owning accounts, sessions and the account→device
 * binding. Everything identity-related goes through this class; no other
 * component may read or write these tables.
 */
export class AccountRegistry extends DurableObject<Env> {
  readonly #store: AccountRegistryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = createAccountRegistryStore({
      exec: (query, ...bindValues) => ctx.storage.sql.exec(query, ...bindValues).toArray() as unknown as RegistryRow[],
    });
    this.#store.ensureSchema();
  }

  async register(input: {
    readonly email: string;
    readonly password: string;
    readonly atMilliseconds: number;
  }): Promise<AuthIssueOutcome> {
    if (!isWellFormedEmail(input.email) || !isAcceptablePassword(input.password)) {
      return { status: 'malformed_input', accountId: null };
    }
    const emailHash = await emailLookupHash(input.email);
    if (this.#store.findAccountIdByEmailHash(emailHash) !== null) {
      return { status: 'email_taken', accountId: null };
    }
        const passwordHash = serializePasswordHash(
      await hashPassword(input.password, resolvePbkdf2Iterations(this.env)),
    );
    const outcome = this.#store.createAccount({
      accountId: generateAccountId(),
      emailHash,
      passwordHash,
      tier: 'free',
      atMilliseconds: input.atMilliseconds,
    });
    if (outcome.status !== 'created') {
      return { status: 'email_taken', accountId: null };
    }
    return this.#issueSessionForAccount(outcome.account.accountId, input.atMilliseconds);
  }

  async login(input: {
    readonly email: string;
    readonly password: string;
    readonly atMilliseconds: number;
  }): Promise<AuthIssueOutcome> {
    if (!isWellFormedEmail(input.email) || !isAcceptablePassword(input.password)) {
      return { status: 'invalid_credentials', accountId: null };
    }
    const emailHash = await emailLookupHash(input.email);
    const accountId = this.#store.findAccountIdByEmailHash(emailHash);
    // Same response for unknown email and wrong password: no account enumeration.
    if (accountId === null) {
      await hashPassword(input.password, resolvePbkdf2Iterations(this.env));
      return { status: 'invalid_credentials', accountId: null };
    }
    const account = this.#store.readAccount(accountId);
    if (account === null || !(await verifyPassword(input.password, account.passwordHash))) {
      return { status: 'invalid_credentials', accountId: null };
    }
    return this.#issueSessionForAccount(account.accountId, input.atMilliseconds);
  }

  async logout(input: { readonly token: string; readonly atMilliseconds: number }): Promise<boolean> {
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    if (resolved === null) {
      return false;
    }
    const tokenHash = await this.#tokenHash(input.token);
    return this.#store.revokeSessionByTokenHash(tokenHash, input.atMilliseconds);
  }

  async session(input: { readonly token: string; readonly atMilliseconds: number }): Promise<SessionOutcome> {
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    return resolved === null
      ? { status: 'unauthorized' }
      : { status: 'ok', accountId: resolved.accountId };
  }

  async enrollDevice(input: {
    readonly token: string;
    readonly deviceId: string;
    readonly deviceType: string;
    readonly deviceName: string;
    readonly atMilliseconds: number;
  }): Promise<SessionOutcome> {
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    if (resolved === null) {
      return { status: 'unauthorized' };
    }
    this.#store.enrollDevice({
      deviceId: input.deviceId,
      accountId: resolved.accountId,
      deviceType: input.deviceType,
      deviceName: input.deviceName,
      atMilliseconds: input.atMilliseconds,
    });
    return { status: 'ok', accountId: resolved.accountId };
  }

  async listDevices(input: { readonly token: string; readonly atMilliseconds: number }): Promise<DeviceListOutcome> {
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    if (resolved === null) {
      return { status: 'unauthorized' };
    }
    return {
      status: 'ok',
      devices: this.#store.listDevices(resolved.accountId).map((device) => ({
        deviceId: device.deviceId,
        deviceType: device.deviceType,
        deviceName: device.deviceName,
        createdAtMilliseconds: device.createdAtMilliseconds,
      })),
    };
  }

  async revokeDevice(input: {
    readonly token: string;
    readonly deviceId: string;
    readonly atMilliseconds: number;
  }): Promise<SessionOutcome> {
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    if (resolved === null) {
      return { status: 'unauthorized' };
    }
    const revoked = this.#store.revokeDevice(resolved.accountId, input.deviceId, input.atMilliseconds);
    return revoked ? { status: 'ok', accountId: resolved.accountId } : { status: 'unauthorized' };
  }

  async verifySessionAccount(input: {
    readonly token: string;
    readonly atMilliseconds: number;
    readonly expectedAccountId: string;
  }): Promise<boolean> {
    if (!isValidAccountId(input.expectedAccountId)) {
      return false;
    }
    const resolved = await this.#authority().resolveSessionToken(input.token, input.atMilliseconds);
    return resolved !== null && resolved.accountId === input.expectedAccountId;
  }

  /** Binding dispositivo↔cuenta para autorizar un hello de desktop (FASE 2.4). */
  async resolveDeviceBinding(
    deviceId: string,
  ): Promise<{ readonly accountId: string | null; readonly isRevoked: boolean } | null> {
    return this.#store.resolveDevice(deviceId);
  }

  /** Desktops activos de una cuenta, para resolver capacidades (FASE 2.5). */
  async listAccountDesktopDevices(
    accountId: string,
  ): Promise<
    readonly { readonly deviceId: string; readonly deviceName: string; readonly isRevoked: boolean }[]
  > {
    if (!isValidAccountId(accountId)) {
      return [];
    }
    return this.#store
      .listDevices(accountId)
      .filter((device) => device.deviceType === 'desktop')
      .map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        isRevoked: device.revokedAtMilliseconds !== null,
      }));
  }

  /** FASE 2.6 — instrumentación de usage (sólo rutas de debug con token interno). */
  async debugListUsageEvents(
    accountId: string,
  ): Promise<
    readonly {
      readonly tokens: number;
      readonly requests: number;
      readonly createdAtMilliseconds: number;
    }[]
  > {
    if (!isValidAccountId(accountId)) {
      return [];
    }
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT tokens, requests, created_at FROM usage_events WHERE account_id = ? ORDER BY created_at DESC LIMIT 50',
        accountId,
      )
      .toArray();
    return rows.map((row) => ({
      tokens: Number(row['tokens'] ?? 0),
      requests: Number(row['requests'] ?? 0),
      createdAtMilliseconds: Number(row['created_at'] ?? 0),
    }));
  }

  async #issueSessionForAccount(accountId: string, atMilliseconds: number): Promise<AuthIssueOutcome> {
    const issued = await issueSessionToken(atMilliseconds);
    this.#store.createSession({
      tokenHash: issued.tokenHash,
      accountId,
      atMilliseconds: issued.issuedAtMilliseconds,
      expiresAtMilliseconds: issued.expiresAtMilliseconds,
    });
    return {
      status: 'ok',
      accountId,
      token: issued.token,
      expiresAtMilliseconds: issued.expiresAtMilliseconds,
    };
  }

  #authority() {
    return createAccountAuthority(this.#store);
  }

  async #tokenHash(token: string): Promise<string> {
    const { sha256Hex } = await import('@/accounts/session');
    return sha256Hex(token);
  }
}
