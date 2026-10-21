import { useAuth } from '@/auth/authStore';

/**
 * Acceso y salida de cuenta delegados al flujo global AuthGate/AuthScreens.
 * Este panel no invoca comandos de autenticación ni mantiene otra sesión.
 */
export function AccountPanel() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const busy = useAuth((s) => s.busy);
  const signOut = useAuth((s) => s.signOut);
  const requestAuthScreen = useAuth((s) => s.requestAuthScreen);

  if (status === 'loading') {
    return (
      <section className="account-panel">
        <p className="account-panel__hint">Cargando cuenta…</p>
      </section>
    );
  }

  if (status === 'signedIn') {
    return (
      <section className="account-panel">
        <p className="account-panel__hint">
          Sesión activa{user?.email ? <> · <strong>{user.email}</strong></> : ''}
        </p>
        <div className="account-panel__actions">
          <button
            type="button"
            className="account-panel__button"
            disabled={busy}
            onClick={() => void signOut()}
          >
            Cerrar sesión
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="account-panel">
      <div className="account-panel__actions">
        <button
          type="button"
          className="account-panel__button"
          onClick={() => requestAuthScreen('signin')}
        >
          Ingresar
        </button>
        <button
          type="button"
          className="account-panel__button"
          onClick={() => requestAuthScreen('signup')}
        >
          Crear cuenta
        </button>
      </div>
    </section>
  );
}
