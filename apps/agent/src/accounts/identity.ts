import { z } from 'zod';

/**
 * Identity primitives for Apollo's multi-user model.
 *
 * The single most important rule in this file: an account is identified by an
 * opaque identifier, never by anything a human can change. Email, device name
 * and platform are all attributes; none of them may ever be used as a primary
 * key, because every one of them is mutable and user-controlled.
 */

/** Opaque account identifier. Stable for the life of the account. */
export const accountIdSchema = z.string().regex(/^acc_[0-9a-f]{32}$/);

export type AccountId = string;

/** Stable per-installation identifier, e.g. `desktop:uuid` / `mobile:uuid`. */
const deviceIdSchema = z.string().regex(/^[a-z]{2,12}:[0-9a-f-]{36}$/);

export type DeviceId = string;

export function isValidAccountId(value: unknown): value is AccountId {
  return typeof value === 'string' && accountIdSchema.safeParse(value).success;
}

/** New opaque account identifier: `acc_` + 32 random hex characters. */
export function generateAccountId(): AccountId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `acc_${hex}`;
}

export function isValidDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string' && deviceIdSchema.safeParse(value).success;
}

export class InvalidAccountIdError extends Error {
  constructor(received: unknown) {
    super(`Invalid account identifier: ${describe(received)}`);
    this.name = 'InvalidAccountIdError';
  }
}

export class InvalidDeviceIdError extends Error {
  constructor(received: unknown) {
    super(`Invalid device identifier: ${describe(received)}`);
    this.name = 'InvalidDeviceIdError';
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 12 ? `${value.slice(0, 12)}...` : value;
  }
  return typeof value;
}

export function requireAccountId(value: unknown): AccountId {
  if (!isValidAccountId(value)) {
    throw new InvalidAccountIdError(value);
  }
  return value;
}

export function requireDeviceId(value: unknown): DeviceId {
  if (!isValidDeviceId(value)) {
    throw new InvalidDeviceIdError(value);
  }
  return value;
}

/**
 * Durable Object name for an account's Apollo instance.
 *
 * This is the heart of the isolation model. Because the DO name *is* the
 * account id, two accounts physically cannot reach each other's storage: there
 * is no query one account can write that resolves to another account's rows.
 * Isolation is structural, not a filter that could be forgotten.
 */
export function apolloObjectNameForAccount(accountId: unknown): string {
  return `acct-${requireAccountId(accountId)}`;
}

/**
 * Durable Object name for the legacy pre-account Apollo instance.
 *
 * Retained for the migration window only. See
 * docs/MIGRATION-APOLLO-DEFAULT.md before removing.
 */
export const LEGACY_APOLLO_OBJECT_NAME = 'default';

/**
 * Account that owns the pre-account `Apollo/default` instance.
 *
 * Deterministic so that every isolate agrees on it without coordination. Its
 * memory namespace differs from every real account's, so legacy data is never
 * silently merged into a user's account.
 */
export const LEGACY_ACCOUNT_ID: AccountId = 'acc_0000000000000000000000000000ffee';

/** Vectorize namespace for an account. Never shared between accounts. */
export function memoryNamespaceForAccount(accountId: unknown): string {
  return `mem:${requireAccountId(accountId)}`;
}

/** Reverse of {@link apolloObjectNameForAccount}, used to reject spoofed names. */
export function accountIdFromApolloObjectName(objectName: string): AccountId | null {
  // `acct-` es la forma canónica (el `:` en el path rompe clientes WS reales —
  // verificado en staging FASE 2.5); `acct:` se acepta por transición.
  const prefix = objectName.startsWith('acct-')
    ? 'acct-'
    : objectName.startsWith('acct:')
      ? 'acct:'
      : null;
  if (prefix === null) {
    return null;
  }
  const candidate = objectName.slice(prefix.length);
  return isValidAccountId(candidate) ? candidate : null;
}

/**
 * Resuelve la cuenta desde el segmento de path, tolerando clientes que
 * codifican `acct:` como `acct%3A` (Android con URLEncoder). Sin decodificar,
 * el borde rechazaría el propio cliente legítimo (verificado en staging,
 * FASE 2.5). Devuelve null si el segmento no es una instancia de cuenta.
 */
export function accountIdFromPathSegment(segment: string): AccountId | null {
  if (!segment.includes('%')) {
    return accountIdFromApolloObjectName(segment);
  }
  try {
    return accountIdFromApolloObjectName(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Reverse of {@link memoryNamespaceForAccount}. */
export function accountIdFromMemoryNamespace(namespace: string): AccountId | null {
  const prefix = 'mem:';
  if (!namespace.startsWith(prefix)) {
    return null;
  }
  const candidate = namespace.slice(prefix.length);
  return isValidAccountId(candidate) ? candidate : null;
}

export const deviceTypeSchema = z.enum([
  'desktop',
  'android',
  'physical',
  'home',
  'tablet',
  'web',
]);

export type DeviceType = z.infer<typeof deviceTypeSchema>;

/**
 * Only desktop and android are implemented today. The remaining members exist
 * so that adding a physical device or a smart-home hub later is an additive
 * enum change rather than a schema migration.
 */
export const IMPLEMENTED_DEVICE_TYPES: readonly DeviceType[] = ['desktop', 'android'];

export function isImplementedDeviceType(value: unknown): value is DeviceType {
  return (
    deviceTypeSchema.safeParse(value).success &&
    IMPLEMENTED_DEVICE_TYPES.includes(value as DeviceType)
  );
}

/**
 * The identity every authenticated operation carries.
 *
 * `accountId` comes from the server-side session lookup, never from a
 * request header, path segment or client-supplied field. `deviceId` comes from
 * the enrolled device credential. Neither is ever taken from user input.
 */
export type Identity = {
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly deviceType: DeviceType;
  /** Session that produced this identity; absent for legacy device-secret auth. */
  readonly sessionId?: string;
  /** True when authenticated by the pre-account global device secret. */
  readonly legacy: boolean;
};

export type Scope =
  | 'memory:read'
  | 'memory:write'
  | 'conversation:read'
  | 'conversation:write'
  | 'device:read'
  | 'device:write'
  | 'device:execute';

const allScopes: readonly Scope[] = [
  'memory:read',
  'memory:write',
  'conversation:read',
  'conversation:write',
  'device:read',
  'device:write',
  'device:execute',
];

/**
 * Scopes granted to an enrolled device of an account.
 *
 * `device:execute` is what actually runs a PC or Android action. Keeping it
 * explicit means a device credential cannot be broadened to "do anything" by
 * future code: adding a capability means editing this list deliberately.
 */
export function defaultScopesForDeviceType(deviceType: DeviceType): readonly Scope[] {
  return allScopes;
}

export function hasScope(identity: Identity, scope: Scope): boolean {
  return defaultScopesForDeviceType(identity.deviceType).includes(scope);
}
