import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceOf = (...segments: string[]): string =>
  readFileSync(join(import.meta.dir, ...segments), 'utf8');

/**
 * Guards sobre el código real de la interfaz.
 *
 * No hay biblioteca de render (ni React Testing Library) en este proyecto, asi
 * que no se puede montar el DOM en un test. Estos guards leen los archivos que
 * la app carga de verdad y verifican que la estructura existe: si alguien saca
 * el boton de Ajustes o vuelve a pedir el nombre en el registro, el test falla.
 *
 * Lo que NO cubren: que el click produzca la navegacion en un navegador real.
 * Eso necesita la app corriendo.
 */

describe('pantalla de registro', () => {
  const authScreens = sourceOf('AuthScreens.tsx');

  it('no pide nombre', () => {
    expect(authScreens).not.toContain('label="Name"');
    expect(authScreens).not.toContain('setName');
    expect(authScreens).not.toContain('signUp(name');
  });

  it('registra solo con email y contraseña', () => {
    expect(authScreens).toContain('signUp(p.email, password)');
  });

  it('no ofrece recuperación de contraseña, porque el backend no la tiene', () => {
    expect(authScreens).not.toContain('Forgot password?');
    expect(authScreens).not.toContain('Send reset link');
    expect(authScreens).not.toContain('Check your inbox');
    expect(authScreens).not.toContain("'forgot'");
    expect(authScreens).not.toContain("'sent'");
  });

  it('muestra el rango de contraseña que realmente acepta el servidor', () => {
    expect(authScreens).toContain('${MIN_PASSWORD}-${MAX_PASSWORD} characters.');
  });
});

describe('onboarding del nombre', () => {
  const onboarding = sourceOf('Onboarding.tsx');
  const authGate = sourceOf('AuthGate.tsx');
  const store = sourceOf('..', 'store', 'index.ts');

  it('el gate muestra el onboarding solo tras un registro y antes de la app', () => {
    expect(authGate).toContain("status === 'signedIn' && pendingOnboarding && !hasCompletedOnboarding");
    expect(authGate).toContain('return <Onboarding />');
  });

  it('el onboarding pide un nombre y lo guarda', () => {
    expect(onboarding).toContain('completeOnboarding(trimmedName)');
    expect(onboarding).toContain('¿Cómo te llamamos?');
  });

  it('el onboarding declara que el nombre es local, no un dato de la cuenta', () => {
    expect(onboarding).toContain('todavía no');
    expect(onboarding).toContain('Este nombre se guarda en este equipo.');
  });

  it('el nombre persiste en el store local y sobrevive al reinicio', () => {
    expect(store).toContain('displayName: state.displayName');
    expect(store).toContain('hasCompletedOnboarding: state.hasCompletedOnboarding');
  });

  it('el registro es lo único que abre el paso de onboarding', () => {
    const authStore = sourceOf('authStore.ts');
    const openCalls = (authStore.match(/setPendingOnboarding\(true\)/g) ?? []).length;
    const closeCalls = (authStore.match(/setPendingOnboarding\(false\)/g) ?? []).length;
    expect(openCalls).toBe(1);
    expect(closeCalls).toBe(1); // solo cerrar sesión baja la bandera
    expect(authStore).toContain('setPendingOnboarding(true)');
  });
});

describe('restauración de sesión', () => {
  const authGate = sourceOf('AuthGate.tsx');

  it('no muestra bienvenida cuando no se pudo verificar la sesión y ofrece reintentar', () => {
    expect(authGate).toContain("status === 'verificationUnavailable'");
    expect(authGate).toContain('No pudimos verificar la sesión');
    expect(authGate).toContain('retryRestore()');
  });
});

describe('acceso a Ajustes desde el chat', () => {
  const chatView = sourceOf('..', 'components', 'Chat', 'ChatView.tsx');
  const chatCss = sourceOf('..', 'components', 'Chat', 'Chat.css');

  it('la cabecera del chat tiene un control de Ajustes con nombre accesible', () => {
    expect(chatView).toContain('aria-label="Abrir Ajustes"');
    expect(chatView).toContain('title="Ajustes"');
  });

  it('el control navega a la sección de Ajustes existente, no a una pantalla nueva', () => {
    expect(chatView).toContain("onClick={() => setActiveSection('settings')}");
    // No se introduce una ruta ni una pantalla duplicada de ajustes.
    expect(chatView).not.toContain('SettingsWindow');
  });

  it('el control tiene área táctil de 44px para Android', () => {
    expect(chatCss).toContain('.apollo-chat-head .apollo-chat-settings');
    const ruleBlock = chatCss.slice(chatCss.indexOf('.apollo-chat-head .apollo-chat-settings'));
    expect(ruleBlock).toContain('min-width: 44px');
    expect(ruleBlock).toContain('min-height: 44px');
  });

  it('la cabecera se adapta a pantallas angostas sin tocar el compositor', () => {
    expect(chatCss).toContain('@media (max-width: 420px)');
  });

  it('la conversación vive en el store: entrar y salir de Ajustes no la reinicia', () => {
    const store = sourceOf('..', 'store', 'index.ts');
    expect(store).toContain('messages: state.messages');
    // ElStore es la unica fuente de mensajes: ChatView no los crea al montar.
    expect(chatView).toContain('const messages = useAppStore((s) => s.messages)');
    expect(chatView).not.toContain('clearMessages()\n  }, []');
  });
});

describe('operaciones de cuenta sin backend', () => {
  const profilePage = sourceOf('..', 'components', 'Settings', 'ProfilePage.tsx');

  it('el perfil no ofrece cambiar el nombre, ni borrar la cuenta', () => {
    expect(profilePage).not.toContain('updateName');
    expect(profilePage).not.toContain('deleteAccount');
    expect(profilePage).not.toContain('changePassword');
  });

  it('el perfil separa el nombre local de los datos que sí devuelve el servidor', () => {
    expect(profilePage).toContain('Nombre elegido en el onboarding. Se guarda en este equipo.');
  });
});
