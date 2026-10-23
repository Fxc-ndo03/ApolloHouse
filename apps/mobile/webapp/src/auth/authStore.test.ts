import { beforeEach, describe, expect, it } from 'bun:test';

import { createAuthStore, useAuth } from './authStore';
import { useAppStore } from '@/store';

/**
 * El store de auth habla con el backend a traves de `invokeStrict`, que en un
 * entorno sin Tauri falla de verdad en vez de devolver `undefined`. Estos tests
 * usan esa falla real: verifican que un error de transporte NUNCA se reporte
 * como sesion iniciada.
 *
 * Lo que NO se prueba aqui: el exito de `account_register`, porque exigiria
 * invocar Tauri. Eso queda para una prueba con el backend real.
 */

const CREDENTIALS = { email: 'persona@ejemplo.com', password: 'a'.repeat(10) };

describe('authStore sin Tauri disponible', () => {
  beforeEach(() => {
    useAppStore.setState({
      displayName: '',
      hasCompletedOnboarding: false,
      pendingOnboarding: false,
    });
    useAuth.setState({ status: 'signedOut', user: null, busy: false, error: null });
  });

  it('no marca sesión iniciada cuando el registro falla por transporte', async () => {
    const didSucceed = await useAuth.getState().signUp(CREDENTIALS.email, CREDENTIALS.password);

    expect(didSucceed).toBe(false);
    expect(useAuth.getState().status).toBe('signedOut');
    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().error).not.toBeNull();
    // Un registro fallido NO abre el onboarding: eso sería un paso del flujo
    // que el usuario nunca empezó.
    expect(useAppStore.getState().pendingOnboarding).toBe(false);
  });

  it('no marca sesión iniciada cuando el login falla por transporte', async () => {
    const didSucceed = await useAuth.getState().signIn(CREDENTIALS.email, CREDENTIALS.password);

    expect(didSucceed).toBe(false);
    expect(useAuth.getState().status).toBe('signedOut');
    expect(useAuth.getState().error).not.toBeNull();
  });

  it('las operaciones de cuenta sin backend fallan con "no disponible", no con éxito', async () => {
    const forgotSucceeded = await useAuth.getState().forgot('persona@ejemplo.com');
    expect(forgotSucceeded).toBe(false);
    expect(useAuth.getState().error?.code).toBe('unsupported');

    const nameSucceeded = await useAuth.getState().updateName('Persona');
    expect(nameSucceeded).toBe(false);
    expect(useAuth.getState().error?.code).toBe('unsupported');

    const passwordSucceeded = await useAuth.getState().changePassword('a'.repeat(10), 'b'.repeat(10));
    expect(passwordSucceeded).toBe(false);
    expect(useAuth.getState().error?.code).toBe('unsupported');

    const deleteSucceeded = await useAuth.getState().deleteAccount('a'.repeat(10));
    expect(deleteSucceeded).toBe(false);
    expect(useAuth.getState().error?.code).toBe('unsupported');
  });

  it('cerrar sesión conserva el nombre del dispositivo', async () => {
    useAppStore.getState().completeOnboarding('Persona Anterior');
    useAuth.setState({ status: 'signedIn', user: null });

    await useAuth.getState().signOut();

    expect(useAuth.getState().status).toBe('signedOut');
    // El nombre elegido en el onboarding es de este equipo, no de la cuenta
    // que se cierra: se conserva para que no haya que volver a preguntarlo.
    expect(useAppStore.getState().displayName).toBe('Persona Anterior');
    expect(useAppStore.getState().hasCompletedOnboarding).toBe(true);
    expect(useAppStore.getState().pendingOnboarding).toBe(false);
  });

  it('no confunde una falla al verificar la sesión con un cierre de sesión y permite reintentar', async () => {
    let attempts = 0;
    const auth = createAuthStore(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network unreachable');
      return {
        authenticated: true,
        account_id: 'acc_test',
        email: 'persona@ejemplo.com',
        session_valid: true,
      };
    });

    await auth.getState().init();

    expect(auth.getState().status).toBe('verificationUnavailable');
    expect(auth.getState().user).toBeNull();
    expect(auth.getState().error?.code).toBe('network');

    await auth.getState().retryRestore();

    expect(attempts).toBe(2);
    expect(auth.getState().status).toBe('signedIn');
    expect(auth.getState().user?.email).toBe('persona@ejemplo.com');
  });

  it('solo informa signedOut cuando el puente confirma que no existe sesión', async () => {
    const auth = createAuthStore(async () => ({
      authenticated: false,
      account_id: '',
      email: '',
      session_valid: false,
    }));

    await auth.getState().init();

    expect(auth.getState().status).toBe('signedOut');
    expect(auth.getState().user).toBeNull();
  });
});
