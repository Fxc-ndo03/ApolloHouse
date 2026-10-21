import { useCallback, useEffect, useState } from 'react';

import { invokeStrict } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { AccountStatus } from '@/store';

const ACCOUNT_ERROR_MESSAGES: Record<string, string> = {
  InvalidCredentials: 'Email o contraseña incorrectos',
  EmailTaken: 'Ese email ya tiene una cuenta',
  InvalidInput: 'Revisá el email y la contraseña (mínimo 10 caracteres)',
  InvalidResponse: 'El servidor respondió algo inesperado',
  Unreachable: 'No se pudo contactar al servidor',
};

export function describeAccountError(rawError: string): string {
  const key = Object.keys(ACCOUNT_ERROR_MESSAGES).find((candidate) =>
    rawError.includes(candidate),
  );
  if (key) return ACCOUNT_ERROR_MESSAGES[key];
  if (rawError.includes('almacen seguro')) {
    return 'No se pudo guardar la sesión en el almacén seguro';
  }
  return rawError.trim().length > 0 ? rawError : 'No se pudo completar la operación';
}

export async function readAccountStatus(): Promise<AccountStatus> {
  return await invokeStrict<AccountStatus>('account_status');
}

export function AccountPanel() {
  const account = useAppStore((s) => s.account);
  const setAccount = useAppStore((s) => s.setAccount);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setAccount(await readAccountStatus());
    } catch (rawError) {
      setError(describeAccountError(String(rawError)));
    } finally {
      setLoading(false);
    }
  }, [setAccount]);

  // El estado de cuenta vive en el store porque otras vistas (el gate de acceso
  // y Perfil) necesitan el mismo dato. Antes vivía solo acá y cada componente
  // preguntaba por su cuenta: dos verdades para la misma sesión.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAuth = useCallback(
    async (isRegistration: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const command = isRegistration ? 'account_register' : 'account_login';
        const result = await invokeStrict<AccountStatus>(command, {
          credentials: { email: email.trim(), password },
        });
        if (result.authenticated) {
          setPassword('');
          setAccount(result);
        } else {
          setError('El servidor no confirmó la sesión');
        }
      } catch (rawError) {
        setError(describeAccountError(String(rawError)));
      } finally {
        setBusy(false);
      }
    },
    [email, password, setAccount],
  );

  const runLogout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await invokeStrict<AccountStatus>('account_logout'));
    } catch (rawError) {
      setError(describeAccountError(String(rawError)));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh, setAccount]);

  if (loading) {
    return (
      <section className="account-panel">
        <p className="account-panel__hint">Cargando cuenta…</p>
      </section>
    );
  }

  if (account?.authenticated) {
    return (
      <section className="account-panel">
        <p className="account-panel__hint">
          Sesión activa · cuenta <strong>{account.account_id}</strong>
        </p>
        {error !== null && <p className="account-panel__error">{error}</p>}
        <div className="account-panel__actions">
          <button
            type="button"
            className="account-panel__button"
            disabled={busy}
            onClick={() => void runLogout()}
          >
            Cerrar sesión
          </button>
        </div>
      </section>
    );
  }

  const canSubmit = email.trim().length > 0 && password.length >= 10;

  return (
    <section className="account-panel">
      <label className="account-panel__label">
        Email
        <input
          type="email"
          name="apollo-account-email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="account-panel__label">
        Contraseña
        <input
          type="password"
          name="apollo-account-password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error !== null && <p className="account-panel__error">{error}</p>}
      <div className="account-panel__actions">
        <button
          type="button"
          className="account-panel__button"
          disabled={busy || !canSubmit}
          onClick={() => void runAuth(false)}
        >
          Ingresar
        </button>
        <button
          type="button"
          className="account-panel__button"
          disabled={busy || !canSubmit}
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
