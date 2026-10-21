import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEBAPP_SOURCE_ROOT = join(import.meta.dir, '..', 'webapp', 'src');
const WEBAPP_ROOT = join(import.meta.dir, '..', 'webapp');
const ANDROID_WEBVIEW_ROOT = join(
  import.meta.dir,
  '..',
  'app',
  'src',
  'main',
  'java',
  'com',
  'apollo',
  'mobile',
  'webview',
);

function readWebSource(relativePath: string): string {
  return readFileSync(join(WEBAPP_SOURCE_ROOT, relativePath), 'utf8');
}

function readWebFile(relativePath: string): string {
  return readFileSync(join(WEBAPP_ROOT, relativePath), 'utf8');
}

function readSection(source: string, startMarker: string, endMarker: string): string {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`No se encontró la sección ${startMarker}`);
  }
  return source.slice(startIndex, endIndex);
}

describe('UI React de Android', () => {
  test('mantiene Ajustes accesible con engranaje en inicio y chat', () => {
    const chatSource = readWebSource('chat/ChatApp.tsx');
    const appSource = readWebSource('account/App.tsx');
    const settingsButtonList = chatSource.match(
      /onClick=\{onSettings\} aria-label="Settings"><Icon n="gear" \/>/g,
    );

    expect(settingsButtonList).toHaveLength(2);
    expect(appSource).toContain("onSettings={() => setView('settings')}");
  });

  test('el build apunta al directorio que sirve Android WebView', () => {
    const viteConfig = readWebFile('vite.config.ts');
    const navigationPolicy = readFileSync(
      join(ANDROID_WEBVIEW_ROOT, 'ApolloWebNavigationPolicy.kt'),
      'utf8',
    );

    expect(viteConfig).toContain("base: command === 'build' ? '/assets/webapp/' : '/'");
    expect(navigationPolicy).toContain('assets/webapp/index.html');
  });

  test('la UI de autenticación ocupa el WebView al terminar el splash', () => {
    const accountStyles = readWebSource('account/account.css');

    expect(accountStyles).toContain('html,\nbody,\n#root');
    expect(accountStyles).toContain('height: 100%');
  });

  test('el registro pide correo y contraseña y deja el nombre para onboarding', () => {
    const authSource = readWebSource('account/AuthScreens.tsx');
    const signupSource = readSection(authSource, 'function SignUp(', 'function Sent(');
    const onboardingSource = readWebSource('onboarding/Questions.tsx');

    expect(signupSource).toContain('Field label="Email"');
    expect(signupSource).toContain('Field label="Password"');
    expect(signupSource).not.toContain('Field label="Name"');
    expect(signupSource).toContain('signUp(p.email, password)');
    expect(onboardingSource).toContain('What should I call you?');
  });

  test('el proveedor pasa solo email y contraseña al puente nativo', () => {
    const authTypes = readWebSource('account/types.ts');
    const authStore = readWebSource('account/authStore.ts');
    const bridgeProvider = readWebSource('native/bridgeAuthProvider.ts');
    const bridgeEntry = readWebSource('main.tsx');

    expect(authTypes).toContain('signUp(email: string, password: string)');
    expect(authStore).toContain('provider.signUp(email, password)');
    expect(bridgeProvider).toContain("bridgeCall('auth.register', { email, password })");
    expect(bridgeProvider).not.toContain("bridgeCall('auth.register', { name");
    expect(bridgeEntry).toContain('setAuthProvider(createBridgeAuthProvider())');
  });
});
