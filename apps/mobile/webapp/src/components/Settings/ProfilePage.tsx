import { useCallback, useEffect, useState } from 'react';

import { invokeStrict } from '@/hooks/useTauri';
import { useAppStore } from '@/store';
import type { AccountStatus } from '@/store';
import {
  describeAccountError,
  readAccountStatus,
} from '@/components/Account/AccountPanel';
import { Page } from '@/components/Settings/Page';
import { Group, Label, Row } from '@/components/Settings/controls';

interface ProfilePageProps {
  onBack: () => void;
  onSignedOut: () => void;
}

export function ProfilePage({ onBack, onSignedOut }: ProfilePageProps) {
  const account = useAppStore((s) => s.account);
  const setAccount = useAppStore((s) => s.setAccount);
  const displayName = useAppStore((s) => s.displayName);

  const [loading, setLoading] = useState(account === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccount(await readAccountStatus());
    } catch (rawError) {
      setError(describeAccountError(String(rawError)));
    } finally {
      setLoading(false);
    }
  }, [setAccount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await invokeStrict<AccountStatus>('account_logout'));
      onSignedOut();
    } catch (rawError) {
      setError(describeAccountError(String(rawError)));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [onSignedOut, refresh, setAccount]);

  const isAuthenticated = account?.authenticated === true;

  return (
    <Page
      title="Perfil"
      subtitle={isAuthenticated ? 'Tu sesión de cuenta en este equipo.' : 'Entrá a tu cuenta para usar Apollo.'}
      onBack={onBack}
    >
      {loading ? (
        <Group>
          <Row icon="clock" title="Comprobando sesión…" sub="" />
        </Group>
      ) : isAuthenticated ? (
        <>
          <Label>Sesión activa</Label>
          <Group>
            <Row icon="user" title={displayName || 'Sin nombre'} sub="Nombre elegido en el onboarding. Se guarda en este equipo." />
            <Row icon="shield" title="Cuenta" sub={account?.email || account?.account_id || ''} />
            <Row
              icon="check"
              title="Token de sesión"
              sub={
                account?.session_valid
                  ? 'Guardado cifrado en Credential Manager'
                  : 'Sin token guardado'
              }
            />
          </Group>
          <Label>Acciones</Label>
          <Group>
            <Row
              icon="lock"
              title={busy ? 'Cerrando sesión…' : 'Cerrar sesión'}
              sub="Revoca la sesión en el servidor y la borra de este equipo"
              onClick={busy ? undefined : () => void signOut()}
            />
          </Group>
        </>
      ) : (
        <>
          <Label>Sesión</Label>
          <Group>
            <Row icon="lock" title="Sin sesión activa" sub="Iniciá sesión desde Inicio" />
          </Group>
        </>
      )}

      {error !== null && (
        <Group>
          <Row icon="msg" title={error} sub="" />
        </Group>
      )}
    </Page>
  );
}
