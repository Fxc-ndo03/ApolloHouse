import { useAuth } from '@/auth/authStore';
import { useAppStore } from '@/store';
import type { ActiveSection } from '@/store';

const OPEN_SECTIONS: readonly ActiveSection[] = ['dashboard', 'settings'];

interface AccountGateProps {
  section: ActiveSection;
  children: React.ReactNode;
}

/**
 * Acceso obligatorio: sin sesión de cuenta no se entra al dashboard ni al chat.
 *
 * El gate vive acá y no en cada vista porque un chequeo repetido por componente
 * se olvida en cuanto se agrega una vista nueva, y una vista nueva sin chequeo
 * es exactamente el hueco por donde se usa Apollo sin haber entrado.
 */
export function AccountGate({ section, children }: AccountGateProps) {
  const account = useAppStore((s) => s.account);
  const authStatus = useAuth((s) => s.status);
  const requestAuthScreen = useAuth((s) => s.requestAuthScreen);

  const isLocked = authStatus === 'signedOut' || (account !== null && !account.authenticated);
  const isAllowed = !isLocked || OPEN_SECTIONS.includes(section);

  if (isAllowed) return <>{children}</>;

  return (
    <section className="account-gate" role="alert">
      <h1>Necesitás entrar a tu cuenta</h1>
      <p>Apollo trabaja con tu sesión de cuenta. Iniciá sesión para continuar.</p>
      <button type="button" onClick={() => requestAuthScreen('signin')}>
        Ir a iniciar sesión
      </button>
    </section>
  );
}
