export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'invalid_email'
  | 'weak_password'
  | 'wrong_password'
  | 'rate_limited'
  | 'network'
  | 'session_expired'
  | 'unknown'
  | 'unsupported'
  | 'invalid_input';

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export interface AuthProvider {
  restore(): Promise<AuthUser | null>;
  signIn(email: string, password: string): Promise<AuthUser>;
  /** El registro NO acepta nombre: solo `email` y `password`. */
  signUp(input: { email: string; password: string }): Promise<AuthUser>;
  signOut(): Promise<void>;
  /**
   * Sin implementacion en el backend. Se conserva en el contrato como
   * frontera explicita: la interfaz no ofrece esta operacion.
   */
  requestPasswordReset(email: string): Promise<void>;
  /** Sin implementacion en el backend (no existe `PATCH /api/auth/profile`). */
  updateName(name: string): Promise<AuthUser>;
  /** Sin implementacion en el backend (no existe `POST /api/auth/password`). */
  changePassword(current: string, next: string): Promise<void>;
  /** Sin implementacion en el backend (no existe `DELETE /api/auth/me`). */
  deleteAccount(password: string): Promise<void>;
  /** El backend avisa cuando la sesion deja de valer (revocada, vencida). */
  onSessionExpired?(listener: () => void): () => void;
}

/**
 * El backend es la autoridad. `apps/agent/src/accounts/do.ts:28-29` exige
 * 10..256 caracteres y NO exige letras ni dígitos: la UI valida exactamente eso
 * para no rechazar contraseñas que el servidor acepta, ni aceptar las que
 * rechaza.
 */
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const isValidEmail = (v: string) => v.length <= 254 && EMAIL.test(normalizeEmail(v));

export function passwordIssue(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

/**
 * Campos que el registro realmente envía. `POST /api/auth/register`
 * (`apps/agent/src/auth/routes.ts:45-63`) acepta exactamente `email` y
 * `password`: el nombre NO viaja, y agregarlo sería mandar un campo que el
 * servidor descarta. El nombre se pregunta en el onboarding.
 */
export function buildRegistrationCredentials(
  email: string,
  password: string,
): { readonly email: string; readonly password: string } {
  return { email: normalizeEmail(email), password };
}

export function passwordStrength(pw: string): number {
  if (pw.length < MIN_PASSWORD) return pw.length === 0 ? 0 : 1;
  let s = 2;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export const ERROR_TEXT: Record<AuthErrorCode, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_taken: 'An account with this email already exists.',
  invalid_email: 'Enter a valid email address.',
  weak_password: 'Choose a stronger password.',
  wrong_password: 'That password is incorrect.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  network: "Can't reach Apollo. Check your connection.",
  session_expired: 'Your session expired. Sign in again.',
  unknown: 'Something went wrong. Try again.',
  unsupported: 'This action is not available on this server yet.',
  invalid_input: `Check your email and password (${MIN_PASSWORD}-${MAX_PASSWORD} characters).`,
};

/**
 * Operaciones de cuenta que el backend TODAVÍA no expone. No se muestra un
 * acceso en la interfaz a ninguna de ellas: un botón que no puede completarse
 * es peor que un botón que no existe.
 */
export const UNSUPPORTED_ACCOUNT_OPERATIONS = [
  'requestPasswordReset',
  'updateName',
  'changePassword',
  'deleteAccount',
] as const;