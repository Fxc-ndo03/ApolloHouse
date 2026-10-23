import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '@/store';
import { useAuth } from './authStore';
import { AuthScreens } from './AuthScreens';
import { Onboarding } from './Onboarding';
import { Sparkle } from './parts';
import './account.css';

export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const retryRestore = useAuth((s) => s.retryRestore);
  const pendingOnboarding = useAppStore((s) => s.pendingOnboarding);
  const hasCompletedOnboarding = useAppStore((s) => s.hasCompletedOnboarding);

  useEffect(() => { void useAuth.getState().init(); }, []);

  if (status === 'loading') {
    return (
      <div className="ac ac-splash" role="status" aria-label="Loading">
        <Sparkle size={64} />
      </div>
    );
  }
  if (status === 'verificationUnavailable') {
    return (
      <div className="ac" role="alert">
        <div className="ac-blobs" aria-hidden><i /><i /><i /></div>
        <div className="ac-screen">
          <div className="ac-form center-col">
            <Sparkle size={64} />
            <h1 className="ac-h">No pudimos verificar la sesión</h1>
            <p className="ac-sub">Revisá la conexión e intentá comprobarla de nuevo.</p>
            <button type="button" className="ac-btn" onClick={() => void retryRestore()}>
              Volver a intentar
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (status === 'signedOut') return <AuthScreens />;
  // Tras un registro recien creado se pregunta el nombre antes de entrar. Un
  // login de una cuenta que ya lo tiene no vuelve a preguntar.
  if (status === 'signedIn' && pendingOnboarding && !hasCompletedOnboarding) {
    return <Onboarding />;
  }
  return <>{children}</>;
}
