// Tabla de traduccion: comando de Tauri (lo que usa la UI de Windows) -> operacion del puente Android.
// Fuente de los nombres de operacion: ALLOWED_OPERATIONS de BridgeContract.kt.
// Forma de los resultados: la que espera la UI de Windows (store/index.ts, auth/authStore.ts).

import { ANDROID_SETTINGS_KEYS, APP_SETTINGS_DEFAULTS, pickKeys } from './settingsDefaults';

type Args = Record<string, unknown>;

interface Entry {
  operation: string;
  toArgs?: (a: Args) => Args;
  fromData?: (d: Args, a: Args) => unknown;
}

function credentials(a: Args): { email: string; password: string } {
  const c = (a.credentials ?? {}) as { email?: unknown; password?: unknown };
  return { email: String(c.email ?? ''), password: String(c.password ?? '') };
}

// Resultado de auth.login / auth.register -> AccountStatus de Windows.
function accountFromSignIn(d: Args, email: string) {
  return { authenticated: true, account_id: String(d.accountId ?? ''), email, session_valid: true };
}

export const COMMAND_MAP: Record<string, Entry> = {
  account_status: {
    operation: 'auth.state',
    fromData: (d) => ({
      authenticated: d.signedIn === true,
      account_id: String(d.accountId ?? ''),
      email: String(d.email ?? ''),
      session_valid: d.signedIn === true,
    }),
  },
  account_login: { operation: 'auth.login', toArgs: credentials, fromData: (d, a) => accountFromSignIn(d, credentials(a).email) },
  account_register: { operation: 'auth.register', toArgs: credentials, fromData: (d, a) => accountFromSignIn(d, credentials(a).email) },
  account_logout: {
    operation: 'auth.logout',
    fromData: () => ({ authenticated: false, account_id: '', email: '', session_valid: false }),
  },
  send_text_to_cloud_core: { operation: 'conversation.send', toArgs: (a) => ({ text: String(a.text ?? '') }) },
  manual_listen_start: { operation: 'voice.start' },
  manual_listen_stop: { operation: 'voice.stop' },
  get_settings: {
    operation: 'settings.read',
    // Completa los 17 campos; el secreto de dispositivo nunca viaja a Android.
    fromData: (d) => ({ ...APP_SETTINGS_DEFAULTS, ...pickKeys(d, Object.keys(APP_SETTINGS_DEFAULTS)), device_shared_secret: '' }),
  },
  update_settings: {
    operation: 'settings.write',
    toArgs: (a) => ({ patch: pickKeys((a.data ?? {}) as Args, ANDROID_SETTINGS_KEYS) }),
  },
  check_for_update: { operation: 'updates.check', fromData: (d) => normalizeUpdate(d) },
  // Operacion NUEVA: Kotlin debe agregarla a ALLOWED_OPERATIONS (ver PROMPT-OPENCODE.md).
  download_and_install_update: { operation: 'updates.install' },
};

// Estados que devuelve el puente (UpdateOwner) -> valores del fixture compartido con Windows.
const STATE_TO_KIND: Record<string, string> = {
  idle: 'idle', checking: 'checking', up_to_date: 'upToDate', available: 'available', downloading: 'downloading',
  ready_to_install: 'ready', installer_open: 'pendingRestart', missing_permission: 'failed', error: 'failed',
};

/** Idempotente: si ya llega el sobre del contrato (status.kind), se devuelve tal cual. */
function normalizeUpdate(d: Args): Args {
  if (d.status && typeof d.status === 'object') return d;
  const state = String(d.state ?? 'idle');
  return {
    channel: String(d.channel ?? 'stable'),
    installedVersion: String(d.installedVersion ?? '—'),
    status: { kind: STATE_TO_KIND[state] ?? 'failed', ...(d.reason ? { reason: d.reason } : {}) },
    latestVersion: d.versionName ?? null,
    notes: null,
    publishedAt: null,
    message: d.message ?? null,
  };
}

/** Solo estado de interfaz: no llega a Kotlin. */
export const LOCAL_ONLY = new Set(['set_mic_muted', 'set_tts_muted']);

/** Ventanas de escritorio: en Android serian rutas de la app (pendiente). */
export const NAVIGATION_PENDING = new Set([
  'show_chat_window', 'show_settings_window', 'show_orb_window', 'hide_chat_window', 'hide_orb_window',
]);

/**
 * Codigos del puente -> texto que entiende authStore.ts (codeFromError).
 * Ejemplo: 'unavailable' no contiene 'network', por eso se traduce explicitamente.
 */
export function toWindowsError(code: string | undefined): string {
  switch (code) {
    case 'invalid_credentials': return 'invalid_credentials';
    case 'email_taken': return 'email_taken';
    case 'invalid_input':
    case 'invalid_arguments': return 'invalid_input';
    case 'unavailable':
    case 'not_connected': return 'network unreachable';
    case 'not_authenticated': return 'session expired';
    default: return `unsupported or internal: ${code ?? 'unknown'}`;
  }
}
