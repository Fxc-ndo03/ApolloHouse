import { describe, expect, it } from 'bun:test';
import { COMMAND_MAP, toWindowsError } from '../shim/commandMap';
import { ANDROID_SETTINGS_KEYS, APP_SETTINGS_DEFAULTS } from '../shim/settingsDefaults';

describe('escritura de ajustes en Android', () => {
  it('solo escribe los campos permitidos; el secreto de dispositivo nunca sale hacia el puente', () => {
    const args = COMMAND_MAP.update_settings.toArgs!({
      data: { mic_muted: true, device_shared_secret: 'SECRETO', worker_url: 'https://x', tts_speed: 1.2 },
    });
    expect(args).toEqual({ patch: { mic_muted: true, tts_speed: 1.2 } });
    expect(ANDROID_SETTINGS_KEYS as readonly string[]).not.toContain('device_shared_secret');
  });
});

describe('lectura de ajustes en Android', () => {
  it('completa los 17 campos y descarta cualquier secreto que llegue desde Kotlin', () => {
    const out = COMMAND_MAP.get_settings.fromData!({ mic_muted: true, device_shared_secret: 'FILTRADO' }, {});
    expect(Object.keys(out as object).length).toBe(Object.keys(APP_SETTINGS_DEFAULTS).length);
    expect((out as Record<string, unknown>).device_shared_secret).toBe('');
    expect((out as Record<string, unknown>).mic_muted).toBe(true);
  });
});

describe('estado de actualizacion (contrato compartido con Windows)', () => {
  it('traduce el estado del puente al sobre con status.kind', () => {
    const out = COMMAND_MAP.check_for_update.fromData!({ state: 'up_to_date', versionName: '1.2.0' }, {}) as Record<string, unknown>;
    expect(out.status).toEqual({ kind: 'upToDate' });
    expect(out.latestVersion).toBe('1.2.0');
    expect(out.channel).toBe('stable');
  });
  it('mapea los estados con nombre distinto del contrato', () => {
    const kinds = ['ready_to_install', 'installer_open', 'missing_permission', 'error'].map(
      (state) => (COMMAND_MAP.check_for_update.fromData!({ state }, {}) as { status: { kind: string } }).status.kind,
    );
    expect(kinds).toEqual(['ready', 'pendingRestart', 'failed', 'failed']);
  });
  it('es idempotente: un sobre ya conforme pasa sin cambios', () => {
    const sobre = { channel: 'stable', status: { kind: 'available' }, latestVersion: '2.0.0' };
    expect(COMMAND_MAP.check_for_update.fromData!(sobre, {})).toBe(sobre);
  });
});

describe('errores del puente hacia la UI de Windows', () => {
  it('traduce unavailable a un error de red que la UI reconoce', () => {
    expect(toWindowsError('unavailable')).toBe('network unreachable');
  });
  it('mantiene las credenciales incorrectas y traduce la sesion vencida', () => {
    expect(toWindowsError('invalid_credentials')).toBe('invalid_credentials');
    expect(toWindowsError('not_authenticated')).toBe('session expired');
  });
  it('un codigo desconocido no se disfraza de exito', () => {
    expect(toWindowsError('algo_raro').startsWith('unsupported or internal')).toBe(true);
  });
});

describe('cobertura de comandos', () => {
  it('todas las operaciones de cuenta y conversacion estan mapeadas', () => {
    for (const cmd of ['account_status', 'account_login', 'account_register', 'account_logout', 'send_text_to_cloud_core']) {
      expect(COMMAND_MAP[cmd]).toBeDefined();
    }
  });
});
