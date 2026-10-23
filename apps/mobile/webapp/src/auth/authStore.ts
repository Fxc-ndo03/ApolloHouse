import { create } from 'zustand';
import { invokeStrict } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { AccountStatus } from '@/store';
import { AuthError, ERROR_TEXT, buildRegistrationCredentials } from './types';
import type { AuthErrorCode, AuthProvider, AuthUser } from './types';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'verificationUnavailable';

function mapStatus(status: AccountStatus, emailFallback?: string): AuthUser | null {
  if (!status.authenticated) return null;
  // El backend no tiene un campo de nombre: `/api/auth/register` y
  // `/api/auth/login` devuelven solo `accountId`, `sessionToken` y `expiresAt`
  // (apps/agent/src/auth/routes.ts:52-58). Lo que llega aca es una copia local
  // de lo que el usuario escribio. `name` queda como el nombre elegido en el
  // onboarding, que es local; nunca se inventa uno a partir del correo.
  const email = (status.email || emailFallback || '').trim().toLowerCase();
  return { id: status.account_id, email, name: '', createdAt: Date.now() };
}

function codeFromError(raw: string): AuthErrorCode {
  const low = raw.toLowerCase().replace(/[\s_]/g, '');
  if (low.includes('invalidcredentials')) return 'invalid_credentials';
  if (low.includes('emailtaken')) return 'email_taken';
  if (low.includes('invalidinput')) return 'invalid_input';
  if (low.includes('unreachable') || low.includes('network')) return 'network';
  if (low.includes('sessionexpired')) return 'session_expired';
  return 'unknown';
}

interface Store {
  status: AuthStatus;
  user: AuthUser | null;
  busy: boolean;
  error: { code: AuthErrorCode; message: string } | null;
  init: () => Promise<void>;
  retryRestore: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<boolean>;
  /** Registra con email y password. El nombre se pregunta en el onboarding. */
  signUp: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  forgot: (email: string) => Promise<boolean>;
  updateName: (name: string) => Promise<boolean>;
  changePassword: (current: string, next: string) => Promise<boolean>;
  deleteAccount: (password: string) => Promise<boolean>;
  clearError: () => void;
}

const toError = (e: unknown) => {
  if (e instanceof AuthError) return { code: e.code, message: ERROR_TEXT[e.code] } as const;
  const raw = e instanceof Error ? e.message : String(e);
  const code = codeFromError(raw);
  return { code, message: code === 'unknown' && raw.trim() ? raw : ERROR_TEXT[code] };
};

export function createAuthStore(
  readAccountStatus: () => Promise<AccountStatus> = () => invokeStrict<AccountStatus>('account_status'),
) {
  let initInFlight: Promise<void> | null = null;

  return create<Store>((set, get) => {
    const run = async (fn: () => Promise<void>): Promise<boolean> => {
      if (get().busy) return false;
      set({ busy: true, error: null });
      try {
        await fn();
        return true;
      } catch (e) {
        const err = toError(e);
        if (err.code === 'session_expired') set({ status: 'signedOut', user: null });
        set({ error: err });
        return false;
      } finally {
        set({ busy: false });
      }
    };

    return {
      status: 'loading',
      user: null,
      busy: false,
      error: null,

      init: async () => {
        if (initInFlight) return initInFlight;
        initInFlight = (async () => {
          try {
            const status = await readAccountStatus();
            useAppStore.getState().setAccount(status);
            const user = mapStatus(status);
            set({ user, status: user ? 'signedIn' : 'signedOut', error: null });
          } catch (e) {
            // A transport/bridge failure does not prove that the saved session is
            // invalid. Keep the app behind the auth gate and let the user retry;
            // only an explicit `{ authenticated: false }` response signs out.
            useAppStore.getState().setAccount(null);
            set({ user: null, status: 'verificationUnavailable', error: toError(e) });
          }
        })();
        try {
          await initInFlight;
        } finally {
          initInFlight = null;
        }
      },

      retryRestore: async () => {
        if (get().status !== 'verificationUnavailable') return;
        set({ status: 'loading', error: null });
        await get().init();
      },

      signIn: (email, password) =>
        run(async () => {
          const status = await invokeStrict<AccountStatus>('account_login', {
            credentials: { email: email.trim(), password },
          });
          useAppStore.getState().setAccount(status);
          const user = mapStatus(status, email);
          if (!user) throw new AuthError('invalid_credentials');
          set({ user, status: 'signedIn' });
        }),

      signUp: (email, password) =>
        run(async () => {
          const status = await invokeStrict<AccountStatus>('account_register', {
            credentials: buildRegistrationCredentials(email, password),
          });
          useAppStore.getState().setAccount(status);
          const user = mapStatus(status, email);
          if (!user) throw new AuthError('invalid_credentials');
          // El registro recién creado es el único caso que exige onboarding:
          // es cuando todavía no hay nombre elegido en ningún lado.
          useAppStore.getState().setPendingOnboarding(true);
          set({ user, status: 'signedIn' });
        }),

      signOut: async () => {
        try { await invokeStrict('account_logout'); } catch { /* noop */ }
        useAppStore.getState().setAccount({ authenticated: false, account_id: '', email: '', session_valid: false });
        // El nombre elegido en el onboarding pertenece a este equipo, no a la
        // cuenta que se cierra: no se borra al cambiar de sesión. Solo se baja
        // la bandera de "pendiente" para no mostrarlo dos veces.
        useAppStore.getState().setPendingOnboarding(false);
        set({ user: null, status: 'signedOut', error: null });
      },

      forgot: (_email: string) => run(async () => { throw new AuthError('unsupported'); }),
      updateName: (_name: string) => run(async () => { throw new AuthError('unsupported'); }),
      changePassword: (_current: string, _next: string) => run(async () => { throw new AuthError('unsupported'); }),
      deleteAccount: (_password: string) => run(async () => { throw new AuthError('unsupported'); }),

      clearError: () => set({ error: null }),
    };
  });
}

export const useAuth = createAuthStore();

// shims to satisfy AuthProvider consumers; not used by UI.
export function setAuthProvider(_p: AuthProvider) {
  // Compatibility shim for the shared account UI. Android owns auth natively.
}

// expose user for AccountPage usage if needed
export const __map = mapStatus;
