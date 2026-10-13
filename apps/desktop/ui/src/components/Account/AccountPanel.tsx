import { useCallback, useState } from 'react';

import { invoke } from '@/hooks/useTauri';

/**
 * FASE 2.3 — panel de cuenta. Login/registro contra `/api/auth` via Tauri
 * commands. El password viaja como argumento del comando (proceso interno) y
 * el token de sesión se guarda en Credential Manager del lado Rust: la UI
 * nunca lo recibe ni lo muestra.
 */
type AccountStatus = {
  authenticated: boolean;
  account_id: string;
  session_valid: boolean;
};

const ACCOUNT_ERROR_MESSAGES: Record<string, string> = {
  InvalidCredentials: 'Email o contraseña incorrectos',
  EmailTaken: 'Ese email ya tiene una cuenta',
  InvalidInput: 'Revisá el email y la contraseña (mínimo 10 caracteres)',
  InvalidResponse: 'El servidor respondió algo inesperado',
  Unreachable: 'No se pudo contactar al Worker',
};

function describeAccountError(rawError: string): string {
  const key = Object.keys(ACCOUNT_ERROR_MESSAGES).find((candidate) =>
    rawError.includes(candidate),
  );
  return key ? ACCOUNT_ERROR_MESSAGES[key] : 'No se pudo completar la operación';
}

export function AccountPanel() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const current = await invoke<AccountStatus>('account_status');
    if (current) setStatus(current);
  }, []);

  const runAuth = useCallback(
    async (isRegistration: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const command = isRegistration ? 'account_register' : 'account_login';
        const result = await invoke<AccountStatus>(command, {
          credentials: { email: email.trim(), password },
        });
        if (result && result.authenticated) {
          setPassword('');
          await refresh();
        } else {
          setError(describeAccountError(''));
        }
      } catch (rawError) {
        setError(describeAccountError(String(rawError)));
      } finally {
        setBusy(false);
      }
    },
    [email, password, refresh],
  );

  const runLogout = useCallback(async () => {
    setBusy(true);
    try {
      await invoke('account_logout');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (status === null) {
    void refresh();
    return (
      <section className="account-panel">
        <p className="account-panel__hint">Cargando cuenta…</p>
      </section>
    );
  }

  if (status.authenticated) {
    return (
      <section className="account-panel">
        <p className="account-panel__hint">
          Cuenta: <strong>{status.account_id}</strong>
        </p>
        <button
          type="button"
          className="account-panel__button"
          disabled={busy}
          onClick={() => void runLogout()}
        >
          Cerrar sesión
        </button>
      </section>
    );
  }

  return (
    <section className="account-panel">
      <label className="account-panel__label">
        Email
        <input
          type="email"
          value={email}
          autoComplete="username"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="account-panel__label">
        Contraseña
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error !== null && <p className="account-panel__error">{error}</p>}
      <div className="account-panel__actions">
        <button
          type="button"
          className="account-panel__button"
          disabled={busy || email.trim().length === 0 || password.length < 10}
          onClick={() => void runAuth(false)}
        >
          Ingresar
        </button>
        <button
          type="button"
          className="account-panel__button"
          disabled={busy || email.trim().length === 0 || password.length < 10}
          onClick={() => void runAuth(true)}
        >
          Crear cuenta
        </button>
      </div>
      <p className="account-panel__hint">
        El token de sesión se guarda cifrado en Credential Manager.
      </p>
    </section>
  );
}
