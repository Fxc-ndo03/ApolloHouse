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
  const authScreenRequest = useAuth((s) => s.authScreenRequest);
  const dismissAuthScreen = useAuth((s) => s.dismissAuthScreen);
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
  if (authScreenRequest !== null) {
    return (
      <AuthScreens
        key={`requested-${authScreenRequest}`}
        initialMode={authScreenRequest}
        onCancel={dismissAuthScreen}
      />
    );
  }
  // Keep the existing app shell available while signed out so people can reach
  // Perfil and the protected Chat gate. AccountGate protects restricted views.
  if (status === 'signedOut') return <>{children}</>;
  // Tras un registro recien creado se pregunta el nombre antes de entrar. Un
  // login de una cuenta que ya lo tiene no vuelve a preguntar.
  if (status === 'signedIn' && pendingOnboarding && !hasCompletedOnboarding) {
    return <Onboarding />;
  }
  return <>{children}</>;
}
