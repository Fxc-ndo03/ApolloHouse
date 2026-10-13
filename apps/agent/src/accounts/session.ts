export const SESSION_TOKEN_BYTE_COUNT = 32;
export const SESSION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export type IssuedSessionToken = {
  /** Opaque token handed to the client exactly once. */
  readonly token: string;
  /** SHA-256 of the token — the only form ever persisted. */
  readonly tokenHash: string;
  readonly issuedAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Opaque session token: 256 bits from the platform CSPRNG, base64url. The
 * server only ever stores `sha256Hex(token)`, so a database leak cannot be
 * replayed against the API.
 */
export async function issueSessionToken(
  atMilliseconds: number,
  ttlMilliseconds: number = SESSION_TTL_MILLISECONDS,
): Promise<IssuedSessionToken> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTE_COUNT));
  const base64 = btoa(String.fromCharCode(...randomBytes));
  const token = base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return {
    token,
    tokenHash: await sha256Hex(token),
    issuedAtMilliseconds: atMilliseconds,
    expiresAtMilliseconds: atMilliseconds + ttlMilliseconds,
  };
}

/** Bearer tokens that belong to the device-credential space, never sessions. */
export function isDeviceCredentialToken(token: string): boolean {
  return token.startsWith('apollo_dev_') || token.startsWith('apollo_enr_');
}
