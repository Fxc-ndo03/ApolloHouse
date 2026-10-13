export type PasswordHashResult = {
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly saltBase64: string;
  readonly hashBase64: string;
};

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTE_COUNT = 16;
const DERIVED_KEY_BYTE_COUNT = 32;

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * PBKDF2-HMAC-SHA256 via WebCrypto — the only KDF available inside Workers
 * without native or WASM dependencies. 210k iterations follows the OWASP
 * floor for PBKDF2-SHA256; lower it via `iterations` only with a documented
 * reason (e.g. Workers free-plan CPU limits).
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PasswordHashResult> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTE_COUNT));
  const derivedKey = await derivePasswordKey(password, salt, iterations);
  return {
    algorithm: 'pbkdf2-sha256',
    iterations,
    saltBase64: toBase64(salt.buffer as ArrayBuffer),
    hashBase64: toBase64(derivedKey),
  };
}

export function serializePasswordHash(hash: PasswordHashResult): string {
  return `pbkdf2-sha256$${hash.iterations}$${hash.saltBase64}$${hash.hashBase64}`;
}

export async function verifyPassword(
  password: string,
  serializedHash: string,
): Promise<boolean> {
  const parts = serializedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
    return false;
  }
  let expectedHash: Uint8Array;
  let salt: Uint8Array;
  try {
    expectedHash = fromBase64(parts[3]);
    salt = fromBase64(parts[2]);
  } catch {
    return false;
  }
  const derivedKey = new Uint8Array(await derivePasswordKey(password, salt, iterations));
  if (derivedKey.byteLength !== expectedHash.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < derivedKey.byteLength; index += 1) {
    difference |= derivedKey[index] ^ expectedHash[index];
  }
  return difference === 0;
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt.buffer as ArrayBuffer,
      iterations,
    },
    passwordKey,
    DERIVED_KEY_BYTE_COUNT * 8,
  );
}

/** Deterministic, non-reversible email key: no plaintext email at rest. */
export async function emailLookupHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return toBase64(digest);
}
