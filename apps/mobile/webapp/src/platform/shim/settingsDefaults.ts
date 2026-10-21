// Forma de AppSettingsData (hooks/useTauri.ts, 17 campos). Se usa para completar lo que devuelve el puente.
// En Android solo se ESCRIBEN los campos de ANDROID_SETTINGS_KEYS. device_shared_secret nunca se lee ni se escribe.
export const ANDROID_SETTINGS_KEYS = ['mic_muted', 'tts_muted', 'tts_provider', 'tts_voice', 'tts_language', 'tts_speed'] as const;

export const APP_SETTINGS_DEFAULTS: Record<string, unknown> = {
  worker_url: '',
  device_shared_secret: '',
  wake_words: [],
  use_vosk_wake: false,
  wake_model_dir: null,
  response_output_target: '',
  autostart_enabled: false,
  mic_muted: false,
  tts_muted: false,
  use_local_core: false,
  core_lan_url: '',
  tts_provider: 'cloudflare',
  tts_voice: '',
  tts_language: 'es',
  tts_speed: 1,
  input_device_name: '',
  output_device_name: '',
};

export function pickKeys(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in source) out[k] = source[k];
  return out;
}
