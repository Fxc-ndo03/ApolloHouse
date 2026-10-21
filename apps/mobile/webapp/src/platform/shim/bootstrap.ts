// Se ejecuta antes que la app en el build de Android.
// 1) El guard de useTauri.ts exige __TAURI_INTERNALS__: es solo una marca de "hay un host que resuelve comandos".
// 2) Marca la plataforma para que los componentes ajusten la interfaz (ver platform/platform.ts).
const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
if (!w.__TAURI_INTERNALS__) w.__TAURI_INTERNALS__ = { platform: 'android-webview-shim' };
document.documentElement.dataset.platform = 'android';
export {};
