import { useCallback } from 'react';

import { useAuth } from '@/auth/authStore';
import { useAppStore } from '@/store';
import { Page } from '@/components/Settings/Page';
import { Group, Label, Row } from '@/components/Settings/controls';

interface ProfilePageProps {
  onBack: () => void;
  onSignedOut: () => void;
}

export function ProfilePage({ onBack, onSignedOut }: ProfilePageProps) {
  const authStatus = useAuth((s) => s.status);
  const authUser = useAuth((s) => s.user);
  const authBusy = useAuth((s) => s.busy);
  const authError = useAuth((s) => s.error);
  const signOut = useAuth((s) => s.signOut);
  const requestAuthScreen = useAuth((s) => s.requestAuthScreen);
  const account = useAppStore((s) => s.account);
  const displayName = useAppStore((s) => s.displayName);

  const handleSignOut = useCallback(async () => {
    await signOut();
    onSignedOut();
  }, [onSignedOut, signOut]);

  const isAuthenticated = authStatus === 'signedIn' && account?.authenticated === true;

  return (
    <Page
      title="Perfil"
      subtitle={isAuthenticated ? 'Tu sesión de cuenta en este equipo.' : 'Entrá a tu cuenta para usar Apollo.'}
      onBack={onBack}
    >
      {authStatus === 'loading' ? (
        <Group>
          <Row icon="clock" title="Comprobando sesión…" sub="" />
        </Group>
      ) : isAuthenticated ? (
        <>
          <Label>Sesión activa</Label>
          <Group>
            <Row icon="user" title={displayName || 'Sin nombre'} sub="Nombre elegido en el onboarding. Se guarda en este equipo." />
            <Row icon="shield" title="Cuenta" sub={account?.email || authUser?.email || account?.account_id || authUser?.id || ''} />
            <Row
              icon="check"
              title="Token de sesión"
              sub={
                account?.session_valid
                  ? 'Guardado cifrado en Credential Manager'
                  : account?.session_present
                    ? 'Guardado, pero el Worker no lo valida; iniciá sesión de nuevo'
                    : 'Sin token guardado'
              }
            />
          </Group>
          <Label>Acciones</Label>
          <Group>
            <Row
              icon="lock"
              title={authBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}
              sub="Revoca la sesión en el servidor y la borra de este equipo"
              onClick={authBusy ? undefined : () => void handleSignOut()}
            />
          </Group>
        </>
      ) : (
        <>
          <Label>Sesión</Label>
          <Group>
            <Row icon="lock" title="Sin sesión activa" sub="Iniciá sesión o creá una cuenta para usar Apollo." />
            <Row
              icon="user"
              title="Ingresar o crear cuenta"
              sub="Abrí el formulario de acceso y registro."
              onClick={() => requestAuthScreen('welcome')}
            />
          </Group>
        </>
      )}

      {authError !== null && (
        <Group>
          <Row icon="msg" title={authError.message} sub="" />
        </Group>
      )}
    </Page>
  );
}
